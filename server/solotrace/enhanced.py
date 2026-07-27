from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .audio import AudioProcessingError, build_rhythm_map
from .fingering import assign_fingerings
from .models import Confidence, NoteEvent, TabDocument
from .timing import audio_frame_to_score_tick


def _command_error(error: subprocess.CalledProcessError, fallback: str) -> str:
    output = error.stderr if isinstance(error.stderr, str) else ""
    lines = output.strip().splitlines()
    return lines[-1] if lines else fallback


def _techniques(curve: list[float]) -> list[str]:
    if not curve:
        return []
    values = np.asarray(curve)
    techniques = []
    if float(values.max() - values.min()) >= 70 and float(values[-1] - values[0]) > 45:
        techniques.append("bend")
    centered = values - np.median(values)
    if (
        len(values) >= 8
        and np.std(centered) >= 9
        and np.count_nonzero(np.diff(np.signbit(centered))) >= 3
    ):
        techniques.append("vibrato")
    return techniques


def tab_from_basic_pitch_events(
    events: list[dict[str, object]],
    rhythm_path: Path,
    start_s: float,
    end_s: float,
    sample_rate: int,
    tuning: list[int],
    fret_count: int,
    preferred_fret: int | None = None,
) -> TabDocument:
    tempo, anchors = build_rhythm_map(
        rhythm_path,
        start_s,
        end_s,
        sample_rate,
    )
    passage_duration = end_s - start_s
    notes: list[NoteEvent] = []
    for event in events:
        onset = max(0.0, float(event["onset"]))
        offset = min(passage_duration, float(event["offset"]))
        pitch = int(event["pitch"])
        if offset - onset < 0.05:
            continue
        if not any(0 <= pitch - open_pitch <= fret_count for open_pitch in tuning):
            continue
        absolute_onset = start_s + onset
        absolute_offset = start_s + offset
        onset_frame = round(absolute_onset * sample_rate)
        end_frame = max(onset_frame + 1, round(absolute_offset * sample_rate))
        raw_bends = list(event.get("bends", []))
        indexes = np.linspace(
            0,
            len(raw_bends) - 1,
            min(48, len(raw_bends)),
            dtype=int,
        )
        curve = [round(float(raw_bends[index]) * 100 / 3, 1) for index in indexes]
        confidence = max(0.3, min(0.98, 0.45 + float(event["confidence"]) * 0.55))
        score_tick = audio_frame_to_score_tick(onset_frame, anchors)
        end_tick = audio_frame_to_score_tick(end_frame, anchors)
        techniques = _techniques(curve)
        notes.append(
            NoteEvent(
                id=f"note-{uuid.uuid4().hex[:10]}",
                onset_frame=onset_frame,
                end_frame=end_frame,
                audio_onset_s=absolute_onset,
                audio_offset_s=absolute_offset,
                score_tick=score_tick,
                duration_ticks=max(1, end_tick - score_tick),
                midi_pitch=pitch,
                pitch_curve_cents=curve,
                string=1,
                fret=0,
                techniques=techniques,
                confidence=Confidence(
                    pitch=confidence,
                    onset=confidence,
                    fingering=0.45,
                    technique=0.72 if techniques else 0.8,
                ),
            )
        )
    if not notes:
        raise AudioProcessingError(
            "Enhanced model found no playable guitar notes in this passage"
        )
    notes.sort(key=lambda note: (note.audio_onset_s, note.midi_pitch))
    return TabDocument(
        sample_rate=sample_rate,
        tempo_bpm=tempo,
        tuning=tuning,
        fret_count=fret_count,
        sync_anchors=anchors,
        notes=assign_fingerings(
            notes,
            tuning,
            fret_count,
            preferred_fret=preferred_fret,
        ),
    )


def transcribe_basic_pitch(
    lead_path: Path,
    rhythm_path: Path,
    start_s: float,
    end_s: float,
    sample_rate: int,
    tuning: list[int],
    fret_count: int,
    workspace: Path,
    worker_command: tuple[str, ...],
    worker_script: Path,
    preferred_fret: int | None = None,
) -> TabDocument:
    segment_path = workspace / "basic-pitch-input.wav"
    with sf.SoundFile(lead_path) as source:
        source.seek(round(start_s * sample_rate))
        segment = source.read(
            round((end_s - start_s) * sample_rate),
            always_2d=True,
            dtype="float32",
        )
    sf.write(segment_path, segment, sample_rate, subtype="PCM_16")
    result_path = workspace / "basic-pitch.json"
    command = [
        *worker_command,
        str(worker_script),
        str(segment_path),
        str(result_path),
        "--minimum-frequency",
        str(float(librosa.midi_to_hz(min(tuning)))),
        "--maximum-frequency",
        str(float(librosa.midi_to_hz(max(tuning) + fret_count))),
    ]
    try:
        worker_environment = os.environ.copy()
        for name in (
            "SOLOTRACE_LAUNCH_SECRET",
            "SOLOTRACE_SESSION_SECRET",
            "SOLOTRACE_MVSEP_API_TOKEN",
        ):
            worker_environment.pop(name, None)
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=600,
            env=worker_environment,
        )
    except subprocess.TimeoutExpired as error:
        raise AudioProcessingError("Enhanced note transcription took too long") from error
    except subprocess.CalledProcessError as error:
        raise AudioProcessingError(
            _command_error(error, "Enhanced note transcription failed")
        ) from error
    try:
        events = json.loads(result_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise AudioProcessingError("Enhanced transcriber returned unreadable notes") from error
    if not isinstance(events, list):
        raise AudioProcessingError("Enhanced transcriber returned invalid notes")
    return tab_from_basic_pitch_events(
        events,
        rhythm_path,
        start_s,
        end_s,
        sample_rate,
        tuning,
        fret_count,
        preferred_fret,
    )
