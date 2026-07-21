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
Cancelled = Callable[[], bool]
LOCAL_CHUNK_SECONDS = 60.0
LOCAL_CHUNK_OVERLAP_SECONDS = 1.0
RHYTHM_SAMPLE_RATE = 11_025


class AudioProcessingError(RuntimeError):
    pass


class AudioProcessingCancelled(AudioProcessingError):
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


def _check_cancelled(cancelled: Cancelled | None) -> None:
    if cancelled is not None and cancelled():
        raise AudioProcessingCancelled("Draft cancelled")


def _chunk_windows(
    start: int,
    end: int,
    sample_rate: int,
    *,
    overlap_seconds: float = LOCAL_CHUNK_OVERLAP_SECONDS,
) -> list[tuple[int, int, int, int]]:
    chunk_frames = max(1, round(LOCAL_CHUNK_SECONDS * sample_rate))
    overlap_frames = max(0, round(overlap_seconds * sample_rate))
    windows: list[tuple[int, int, int, int]] = []
    core_start = start
    while core_start < end:
        core_end = min(end, core_start + chunk_frames)
        windows.append(
            (
                core_start,
                core_end,
                max(start, core_start - overlap_frames),
                min(end, core_end + overlap_frames),
            )
        )
        core_start = core_end
    return windows


def _progress_detail(label: str, completed_frames: int, total_frames: int, sample_rate: int) -> str:
    completed = min(total_frames, completed_frames) / sample_rate
    total = total_frames / sample_rate
    return f"{label} {completed / 60:.1f} of {total / 60:.1f} minutes"


def _selection_fade(
    core_start: int,
    core_end: int,
    selection_start: int,
    selection_end: int,
    fade_frames: int,
) -> np.ndarray:
    positions = np.arange(core_start, core_end)
    mask = np.ones(core_end - core_start, dtype=np.float32)
    fade_in = positions < selection_start + fade_frames
    if np.any(fade_in):
        phase = (positions[fade_in] - selection_start) / max(1, fade_frames)
        mask[fade_in] = 0.5 - 0.5 * np.cos(np.pi * phase)
    fade_out = positions >= selection_end - fade_frames
    if np.any(fade_out):
        phase = (selection_end - positions[fade_out] - 1) / max(1, fade_frames)
        mask[fade_out] = np.minimum(
            mask[fade_out],
            0.5 - 0.5 * np.cos(np.pi * np.maximum(0, phase)),
        )
    return mask


def _write_passthrough(
    source: sf.SoundFile,
    lead_output: sf.SoundFile,
    backing_output: sf.SoundFile,
    frame_count: int,
    cancelled: Cancelled | None,
) -> None:
    remaining = frame_count
    while remaining > 0:
        _check_cancelled(cancelled)
        block = source.read(
            min(65_536, remaining),
            always_2d=True,
            dtype="float32",
        )
        if len(block) == 0:
            break
        lead_output.write(np.zeros_like(block))
        backing_output.write(block)
        remaining -= len(block)


def create_preview_stems(
    original_path: Path,
    lead_path: Path,
    backing_path: Path,
    start_s: float,
    end_s: float,
    progress: Progress | None = None,
    cancelled: Cancelled | None = None,
) -> tuple[int, float]:
    """Build a bounded-memory local preview; intentionally not lead isolation."""
    info = sf.info(original_path)
    sample_rate = info.samplerate
    total_frames = info.frames
    start = max(0, round(start_s * sample_rate))
    end = min(total_frames, round(end_s * sample_rate))
    if end - start < sample_rate // 5:
        raise AudioProcessingError("Selected range is too short")

    nyquist = sample_rate / 2
    high = min(5200 / nyquist, 0.98)
    low = max(90 / nyquist, 0.001)
    sos = butter(5, [low, high], btype="bandpass", output="sos")
    selected_frames = end - start
    windows = _chunk_windows(start, end, sample_rate)
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
        _write_passthrough(source, lead_output, backing_output, start, cancelled)
        for core_start, core_end, analysis_start, analysis_end in windows:
            _check_cancelled(cancelled)
            source.seek(analysis_start)
            passage = source.read(
                analysis_end - analysis_start,
                always_2d=True,
                dtype="float32",
            )
            if len(passage) == 0:
                raise AudioProcessingError("Decoded audio is empty")
            mid = passage.mean(axis=1)
            focused = sosfiltfilt(sos, mid).astype(np.float32)
            harmonic = librosa.effects.harmonic(focused, margin=1.8).astype(np.float32)
            left = core_start - analysis_start
            right = left + core_end - core_start
            estimated = harmonic[left:right]
            estimated *= _selection_fade(
                core_start,
                core_end,
                start,
                end,
                round(sample_rate * 0.12),
            )
            original_core = passage[left:right]
            lead_core = np.repeat(estimated[:, None], source.channels, axis=1)
            lead_output.write(lead_core)
            backing_output.write(np.clip(original_core - lead_core * 0.62, -1, 1))
            if progress is not None:
                progress(
                    _progress_detail(
                        "Separated",
                        core_end - start,
                        selected_frames,
                        sample_rate,
                    )
                )
        source.seek(end)
        _write_passthrough(
            source,
            lead_output,
            backing_output,
            total_frames - end,
            cancelled,
        )
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
        before_rms < 0.002 or (after_rms >= before_rms * 1.4 and after_rms - before_rms >= 0.003)
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
    progress: Progress | None = None,
    cancelled: Cancelled | None = None,
) -> tuple[float, list[SyncAnchor]]:
    info = sf.info(rhythm_path)
    start_frame = max(0, round(start_s * sample_rate))
    end_frame = min(round(end_s * sample_rate), round(info.frames / info.samplerate * sample_rate))
    source_start = max(0, round(start_s * info.samplerate))
    source_end = min(info.frames, round(end_s * info.samplerate))
    windows = _chunk_windows(
        source_start,
        source_end,
        info.samplerate,
        overlap_seconds=2.0,
    )
    tempos: list[float] = []
    detected_beats: list[float] = []
    with sf.SoundFile(rhythm_path) as source:
        for core_start, core_end, analysis_start, analysis_end in windows:
            _check_cancelled(cancelled)
            source.seek(analysis_start)
            block = source.read(
                analysis_end - analysis_start,
                always_2d=True,
                dtype="float32",
            )
            mono = block.mean(axis=1)
            if info.samplerate != RHYTHM_SAMPLE_RATE:
                mono = librosa.resample(
                    mono,
                    orig_sr=info.samplerate,
                    target_sr=RHYTHM_SAMPLE_RATE,
                )
            tempo_result, beat_frames = librosa.beat.beat_track(
                y=mono,
                sr=RHYTHM_SAMPLE_RATE,
                hop_length=hop_length,
            )
            chunk_tempo = float(np.asarray(tempo_result).reshape(-1)[0])
            if math.isfinite(chunk_tempo) and 35 <= chunk_tempo <= 400:
                tempos.append(chunk_tempo)
            analysis_start_s = analysis_start / info.samplerate
            core_start_s = core_start / info.samplerate
            core_end_s = core_end / info.samplerate
            for relative_time in librosa.frames_to_time(
                beat_frames,
                sr=RHYTHM_SAMPLE_RATE,
                hop_length=hop_length,
            ):
                absolute_time = analysis_start_s + float(relative_time)
                if core_start_s <= absolute_time < core_end_s:
                    detected_beats.append(absolute_time)
            if progress is not None:
                progress(
                    _progress_detail(
                        "Timed",
                        core_end - source_start,
                        source_end - source_start,
                        info.samplerate,
                    )
                )

    tempo = float(np.median(tempos)) if tempos else 120.0
    beat_times: list[float] = []
    for beat_time in sorted(detected_beats):
        if not beat_times or beat_time - beat_times[-1] >= 0.05:
            beat_times.append(beat_time)
    quarter_seconds = 60 / tempo
    anchors: list[SyncAnchor] = [
        SyncAnchor(audio_frame=start_frame, score_tick=0),
    ]
    if beat_times:
        score_tick = max(1, round((beat_times[0] - start_s) / quarter_seconds * 480))
        previous_time = beat_times[0]
        for index, beat_time in enumerate(beat_times):
            if index:
                beat_steps = max(1, round((beat_time - previous_time) / quarter_seconds))
                score_tick += beat_steps * 480
                previous_time = beat_time
            frame = round(beat_time * sample_rate)
            if frame <= anchors[-1].audio_frame:
                continue
            anchors.append(
                SyncAnchor(
                    audio_frame=frame,
                    score_tick=score_tick,
                )
            )
        if end_frame > anchors[-1].audio_frame:
            remaining_ticks = round(
                (end_frame - anchors[-1].audio_frame) / sample_rate / quarter_seconds * 480
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
                score_tick=max(1, round((end_s - start_s) / quarter_seconds * 480)),
            ),
        ]
    if len(anchors) > 5000:
        indexes = np.linspace(0, len(anchors) - 1, 5000, dtype=int)
        anchors = [anchors[index] for index in sorted(set(indexes.tolist()))]
    return tempo, anchors


def _analyse_pyin_chunk(
    segment: np.ndarray,
    sample_rate: int,
    analysis_start_frame: int,
    core_start_frame: int,
    core_end_frame: int,
    selected_end_frame: int,
    tuning: list[int],
    fret_count: int,
    hop_length: int,
) -> tuple[list[NoteEvent], set[str]]:
    f0, voiced, voiced_probability = librosa.pyin(
        segment,
        fmin=float(librosa.midi_to_hz(min(tuning))),
        fmax=float(librosa.midi_to_hz(max(tuning) + fret_count)),
        sr=sample_rate,
        frame_length=2048,
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
    notes: list[NoteEvent] = []
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
        valid = voiced[voiced_left:voiced_right] & np.isfinite(f0[voiced_left:voiced_right])
        frequencies = f0[voiced_left:voiced_right][valid]
        midi_values = librosa.hz_to_midi(frequencies)
        midi_pitch = int(round(float(np.median(midi_values))))
        if not any(0 <= midi_pitch - open_pitch <= fret_count for open_pitch in tuning):
            continue
        absolute_start = analysis_start_frame + voiced_left * hop_length
        absolute_end = min(
            analysis_start_frame + voiced_right * hop_length,
            selected_end_frame,
        )
        if not core_start_frame <= absolute_start < core_end_frame:
            continue
        if (absolute_end - absolute_start) / sample_rate < 0.075:
            continue
        curve_values = (midi_values - midi_pitch) * 100
        sample_indexes = np.linspace(
            0,
            len(curve_values) - 1,
            min(24, len(curve_values)),
            dtype=int,
        )
        curve = curve_values[sample_indexes].round(1).tolist()
        probability = float(np.nanmean(voiced_probability[voiced_left:voiced_right][valid]))
        onset_strength = min(1.0, 0.54 + 0.05 * (voiced_right - voiced_left))
        note_id = f"note-{uuid.uuid4().hex[:10]}"
        techniques = _techniques(curve)
        notes.append(
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
                techniques=techniques,
                confidence=Confidence(
                    pitch=max(0.3, min(0.92, probability * 0.9)),
                    onset=onset_strength,
                    fingering=0.45,
                    technique=0.7 if techniques else 0.78,
                ),
            )
        )
        if left > 0 and _has_clear_attack(segment, left * hop_length, sample_rate):
            attacked_note_ids.add(note_id)
    return notes, attacked_note_ids


def transcribe_pyin(
    lead_path: Path,
    start_s: float,
    end_s: float,
    tuning: list[int],
    fret_count: int,
    rhythm_path: Path | None = None,
    progress: Progress | None = None,
    cancelled: Cancelled | None = None,
) -> TabDocument:
    info = sf.info(lead_path)
    sample_rate = info.samplerate
    start_frame = max(0, round(start_s * sample_rate))
    end_frame = min(info.frames, round(end_s * sample_rate))
    if end_frame - start_frame < sample_rate // 5:
        raise AudioProcessingError("Selected range is too short to transcribe")

    hop_length = 256
    raw_notes: list[NoteEvent] = []
    attacked_note_ids: set[str] = set()
    selected_frames = end_frame - start_frame
    windows = _chunk_windows(start_frame, end_frame, sample_rate)
    with sf.SoundFile(lead_path) as source:
        for core_start, core_end, analysis_start, analysis_end in windows:
            _check_cancelled(cancelled)
            source.seek(analysis_start)
            block = source.read(
                analysis_end - analysis_start,
                always_2d=True,
                dtype="float32",
            )
            segment = block.mean(axis=1)
            chunk_notes, chunk_attacks = _analyse_pyin_chunk(
                segment,
                sample_rate,
                analysis_start,
                core_start,
                core_end,
                end_frame,
                tuning,
                fret_count,
                hop_length,
            )
            raw_notes.extend(chunk_notes)
            attacked_note_ids.update(chunk_attacks)
            if progress is not None:
                progress(
                    _progress_detail(
                        "Transcribed",
                        core_end - start_frame,
                        selected_frames,
                        sample_rate,
                    )
                )
    raw_notes = _merge_note_fragments(raw_notes, attacked_note_ids)
    if not raw_notes:
        raise AudioProcessingError(
            "No clear monophonic guitar notes were found. Continue in the manual editor "
            "or choose a quieter section."
        )

    tempo, anchors = build_rhythm_map(
        rhythm_path or lead_path,
        start_s,
        end_s,
        sample_rate,
        hop_length,
        progress,
        cancelled,
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
