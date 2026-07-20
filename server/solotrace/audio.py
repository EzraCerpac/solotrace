from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import uuid
from collections.abc import Callable
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

from .fingering import assign_fingerings
from .models import Confidence, NoteEvent, SyncAnchor, TabDocument
from .timing import audio_frame_to_score_tick

Progress = Callable[[str], None]


class AudioProcessingError(RuntimeError):
    pass


def ffmpeg_available() -> bool:
    return _executable("ffmpeg") is not None and _executable("ffprobe") is not None


def _executable(name: str) -> str | None:
    configured = os.environ.get(f"SOLOTRACE_{name.upper()}")
    if configured and Path(configured).is_file():
        return configured
    return shutil.which(name)


def probe_audio(path: Path) -> tuple[float, int]:
    if not ffmpeg_available():
        raise AudioProcessingError("FFmpeg is required to inspect uploaded audio")
    command = [
        _executable("ffprobe") or "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate,duration:format=duration",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=45,
        )
        payload = json.loads(result.stdout)
        if not payload.get("streams"):
            raise AudioProcessingError("This file does not contain an audio stream")
        stream = payload["streams"][0]
        sample_rate = int(stream["sample_rate"])
        try:
            duration = float(stream.get("duration"))
        except (TypeError, ValueError):
            duration = float(payload["format"]["duration"])
    except (
        subprocess.SubprocessError,
        IndexError,
        KeyError,
        ValueError,
        json.JSONDecodeError,
    ) as error:
        raise AudioProcessingError("This file does not contain readable audio") from error
    if not 0.2 <= duration <= 60 * 30:
        raise AudioProcessingError("Audio must be between 0.2 seconds and 30 minutes")
    return duration, sample_rate


def canonicalize_audio(source: Path, destination: Path) -> tuple[float, int]:
    probe_audio(source)
    command = [
        _executable("ffmpeg") or "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=240)
    except subprocess.TimeoutExpired as error:
        raise AudioProcessingError("Audio decoding took too long") from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.decode(errors="replace").strip().splitlines()
        detail = message[-1] if message else "FFmpeg could not decode this file"
        raise AudioProcessingError(detail) from error
    decoded_duration, sample_rate = probe_audio(destination)
    return decoded_duration, sample_rate


def _raised_cosine_mask(length: int, start: int, end: int, fade: int) -> np.ndarray:
    mask = np.zeros(length, dtype=np.float32)
    mask[start:end] = 1
    fade = min(fade, max(0, (end - start) // 2))
    if fade:
        curve = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, fade))
        mask[start : start + fade] = curve
        mask[end - fade : end] = curve[::-1]
    return mask


def create_preview_stems(
    original_path: Path,
    lead_path: Path,
    backing_path: Path,
    start_s: float,
    end_s: float,
) -> tuple[int, float]:
    """Best-effort local preview; intentionally labeled as preview, not isolation."""
    info = sf.info(original_path)
    sample_rate = info.samplerate
    total_frames = info.frames
    start = max(0, round(start_s * sample_rate))
    end = min(total_frames, round(end_s * sample_rate))
    if end - start < sample_rate // 5:
        raise AudioProcessingError("Selected solo is too short")
    with sf.SoundFile(original_path) as source:
        source.seek(start)
        passage = source.read(end - start, always_2d=True, dtype="float32")
    if len(passage) == 0:
        raise AudioProcessingError("Decoded audio is empty")

    mid = passage.mean(axis=1)
    nyquist = sample_rate / 2
    high = min(5200 / nyquist, 0.98)
    low = max(90 / nyquist, 0.001)
    sos = butter(5, [low, high], btype="bandpass", output="sos")
    focused = sosfiltfilt(sos, mid).astype(np.float32)
    harmonic = librosa.effects.harmonic(focused, margin=1.8).astype(np.float32)
    mask = _raised_cosine_mask(
        len(passage),
        0,
        len(passage),
        round(sample_rate * 0.12),
    )
    estimated = harmonic * mask
    block_size = 65_536
    cursor = 0
    with (
        sf.SoundFile(original_path) as source,
        sf.SoundFile(
            lead_path,
            mode="w",
            samplerate=sample_rate,
            channels=source.channels,
            subtype="PCM_16",
        ) as lead_output,
        sf.SoundFile(
            backing_path,
            mode="w",
            samplerate=sample_rate,
            channels=source.channels,
            subtype="PCM_16",
        ) as backing_output,
    ):
        while True:
            block = source.read(block_size, always_2d=True, dtype="float32")
            if len(block) == 0:
                break
            lead_block = np.zeros_like(block)
            overlap_start = max(cursor, start)
            overlap_end = min(cursor + len(block), end)
            if overlap_end > overlap_start:
                source_left = overlap_start - start
                source_right = overlap_end - start
                block_left = overlap_start - cursor
                block_right = overlap_end - cursor
                focused_block = estimated[source_left:source_right, None]
                lead_block[block_left:block_right] = np.repeat(
                    focused_block,
                    source.channels,
                    axis=1,
                )
            lead_output.write(lead_block)
            backing_output.write(np.clip(block - lead_block * 0.62, -1, 1))
            cursor += len(block)
    return sample_rate, total_frames / sample_rate


def waveform_peaks(path: Path, points: int = 1800) -> list[float]:
    """Build browser-ready peaks without decoding the whole song into memory."""
    with sf.SoundFile(path) as audio_file:
        block_size = max(1, math.ceil(len(audio_file) / points))
        peaks: list[float] = []
        for block in audio_file.blocks(
            blocksize=block_size,
            dtype="float32",
            always_2d=True,
        ):
            peaks.append(round(float(np.max(np.abs(block))), 5))
    return peaks or [0.0]


def _techniques(curve: list[float]) -> list[str]:
    if not curve:
        return []
    values = np.asarray(curve)
    techniques: list[str] = []
    if float(values.max() - values.min()) >= 70 and float(values[-1] - values[0]) > 45:
        techniques.append("bend")
    centered = values - np.median(values)
    if len(values) >= 8 and np.std(centered) >= 9:
        zero_crossings = np.count_nonzero(np.diff(np.signbit(centered)))
        if zero_crossings >= 3:
            techniques.append("vibrato")
    return techniques


def _has_clear_attack(
    audio: np.ndarray,
    sample_index: int,
    sample_rate: int,
) -> bool:
    window = max(32, round(sample_rate * 0.035))
    left = max(0, sample_index - window)
    right = min(len(audio), sample_index + window)
    before = audio[left:sample_index]
    after = audio[sample_index:right]
    before_rms = float(np.sqrt(np.mean(before**2))) if len(before) else 0
    after_rms = float(np.sqrt(np.mean(after**2))) if len(after) else 0
    return after_rms >= 0.008 and (
        before_rms < 0.002
        or (after_rms >= before_rms * 1.4 and after_rms - before_rms >= 0.003)
    )


def _merge_note_fragments(
    notes: list[NoteEvent],
    attacked_note_ids: set[str],
) -> list[NoteEvent]:
    merged: list[NoteEvent] = []
    for note in sorted(notes, key=lambda item: item.audio_onset_s):
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous.midi_pitch == note.midi_pitch
            and note.audio_onset_s - previous.audio_offset_s <= 0.03
            and note.id not in attacked_note_ids
        ):
            curve = (previous.pitch_curve_cents + note.pitch_curve_cents)[-48:]
            merged[-1] = previous.model_copy(
                update={
                    "end_frame": note.end_frame,
                    "audio_offset_s": note.audio_offset_s,
                    "pitch_curve_cents": curve,
                    "techniques": _techniques(curve),
                    "confidence": previous.confidence.model_copy(
                        update={
                            "pitch": max(
                                previous.confidence.pitch,
                                note.confidence.pitch,
                            ),
                            "onset": max(
                                previous.confidence.onset,
                                note.confidence.onset,
                            ),
                        }
                    ),
                }
            )
        else:
            merged.append(note)
    return merged


def build_rhythm_map(
    rhythm_path: Path,
    start_s: float,
    end_s: float,
    sample_rate: int,
    hop_length: int = 256,
) -> tuple[float, list[SyncAnchor]]:
    rhythm_audio, _ = librosa.load(
        rhythm_path,
        sr=sample_rate,
        mono=True,
        offset=start_s,
        duration=end_s - start_s,
    )
    start_frame = max(0, round(start_s * sample_rate))
    end_frame = start_frame + len(rhythm_audio)
    tempo_result, beat_frames = librosa.beat.beat_track(
        y=rhythm_audio,
        sr=sample_rate,
        hop_length=hop_length,
    )
    tempo = float(np.asarray(tempo_result).reshape(-1)[0])
    if not math.isfinite(tempo) or tempo < 35:
        tempo = 120
    beat_times = (
        librosa.frames_to_time(
            beat_frames,
            sr=sample_rate,
            hop_length=hop_length,
        )
        + start_s
    )
    quarter_seconds = 60 / tempo
    anchors: list[SyncAnchor] = [
        SyncAnchor(audio_frame=start_frame, score_tick=0),
    ]
    if len(beat_times):
        first_tick = max(
            1,
            round((float(beat_times[0]) - start_s) / quarter_seconds * 480),
        )
        for index, beat_time in enumerate(beat_times):
            frame = round(float(beat_time) * sample_rate)
            if frame <= anchors[-1].audio_frame:
                continue
            anchors.append(
                SyncAnchor(
                    audio_frame=frame,
                    score_tick=first_tick + index * 480,
                )
            )
        if end_frame > anchors[-1].audio_frame:
            remaining_ticks = round(
                (end_frame - anchors[-1].audio_frame)
                / sample_rate
                / quarter_seconds
                * 480
            )
            anchors.append(
                SyncAnchor(
                    audio_frame=end_frame,
                    score_tick=anchors[-1].score_tick + max(1, remaining_ticks),
                )
            )
    if len(anchors) < 2:
        anchors = [
            SyncAnchor(audio_frame=start_frame, score_tick=0),
            SyncAnchor(
                audio_frame=end_frame,
                score_tick=round(
                    len(rhythm_audio) / sample_rate / quarter_seconds * 480
                ),
            ),
        ]
    return tempo, anchors


def transcribe_pyin(
    lead_path: Path,
    start_s: float,
    end_s: float,
    tuning: list[int],
    fret_count: int,
    rhythm_path: Path | None = None,
) -> TabDocument:
    audio, sample_rate = librosa.load(
        lead_path,
        sr=None,
        mono=True,
        offset=start_s,
        duration=end_s - start_s,
    )
    start_frame = max(0, round(start_s * sample_rate))
    end_frame = start_frame + len(audio)
    segment = audio
    if len(segment) < sample_rate // 5:
        raise AudioProcessingError("Selected solo is too short to transcribe")

    hop_length = 256
    frame_length = 2048
    f0, voiced, voiced_probability = librosa.pyin(
        segment,
        fmin=float(librosa.midi_to_hz(min(tuning))),
        fmax=float(librosa.midi_to_hz(max(tuning) + fret_count)),
        sr=sample_rate,
        frame_length=frame_length,
        hop_length=hop_length,
        fill_na=np.nan,
    )
    onset_frames = librosa.onset.onset_detect(
        y=segment,
        sr=sample_rate,
        hop_length=hop_length,
        backtrack=True,
        units="frames",
    )
    boundaries = sorted({0, len(f0), *(int(frame) for frame in onset_frames)})

    raw_notes: list[NoteEvent] = []
    attacked_note_ids: set[str] = set()
    for left, right in zip(boundaries, boundaries[1:], strict=False):
        if right - left < 3:
            continue
        segment_valid = voiced[left:right] & np.isfinite(f0[left:right])
        valid_indexes = np.flatnonzero(segment_valid)
        if len(valid_indexes) < 3:
            continue
        voiced_left = left + int(valid_indexes[0])
        voiced_right = left + int(valid_indexes[-1]) + 1
        valid = voiced[voiced_left:voiced_right] & np.isfinite(
            f0[voiced_left:voiced_right]
        )
        frequencies = f0[voiced_left:voiced_right][valid]
        midi_values = librosa.hz_to_midi(frequencies)
        midi_pitch = int(round(float(np.median(midi_values))))
        if not any(0 <= midi_pitch - open_pitch <= fret_count for open_pitch in tuning):
            continue
        absolute_start = start_frame + voiced_left * hop_length
        absolute_end = min(start_frame + voiced_right * hop_length, end_frame)
        if (absolute_end - absolute_start) / sample_rate < 0.075:
            continue
        curve_values = (midi_values - midi_pitch) * 100
        sample_indexes = np.linspace(
            0, len(curve_values) - 1, min(24, len(curve_values)), dtype=int
        )
        curve = curve_values[sample_indexes].round(1).tolist()
        probability = float(
            np.nanmean(voiced_probability[voiced_left:voiced_right][valid])
        )
        onset_strength = min(1.0, 0.54 + 0.05 * (voiced_right - voiced_left))
        note_id = f"note-{uuid.uuid4().hex[:10]}"
        raw_notes.append(
            NoteEvent(
                id=note_id,
                onset_frame=absolute_start,
                end_frame=absolute_end,
                audio_onset_s=absolute_start / sample_rate,
                audio_offset_s=absolute_end / sample_rate,
                score_tick=0,
                duration_ticks=120,
                midi_pitch=midi_pitch,
                pitch_curve_cents=curve,
                string=1,
                fret=0,
                techniques=_techniques(curve),
                confidence=Confidence(
                    pitch=max(0.3, min(0.92, probability * 0.9)),
                    onset=onset_strength,
                    fingering=0.45,
                    technique=0.7 if _techniques(curve) else 0.78,
                ),
            )
        )
        if left > 0 and _has_clear_attack(
            segment,
            left * hop_length,
            sample_rate,
        ):
            attacked_note_ids.add(note_id)
    raw_notes = _merge_note_fragments(raw_notes, attacked_note_ids)
    if not raw_notes:
        raise AudioProcessingError(
            "No clear monophonic guitar notes were found. Continue in the manual editor "
            "or choose a quieter passage."
        )

    tempo, anchors = build_rhythm_map(
        rhythm_path or lead_path,
        start_s,
        end_s,
        sample_rate,
        hop_length,
    )
    timed_notes: list[NoteEvent] = []
    for note in raw_notes:
        tick = audio_frame_to_score_tick(note.onset_frame, anchors)
        end_tick = audio_frame_to_score_tick(note.end_frame, anchors)
        timed_notes.append(
            note.model_copy(
                update={
                    "score_tick": tick,
                    "duration_ticks": max(1, end_tick - tick),
                }
            )
        )
    notes = assign_fingerings(timed_notes, tuning, fret_count)
    return TabDocument(
        sample_rate=sample_rate,
        tempo_bpm=tempo,
        tuning=tuning,
        fret_count=fret_count,
        sync_anchors=anchors,
        notes=notes,
    )
