from __future__ import annotations

import math
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .audio import waveform_peaks
from .fingering import assign_fingerings
from .models import (
    Confidence,
    MediaAsset,
    NoteEvent,
    Passage,
    PipelineStage,
    ProcessingRun,
    Project,
    RunState,
    StageState,
    SyncAnchor,
    TabDocument,
)
from .storage import ProjectStore

DEMO_ID = "northbound-lights-demo"
DEMO_VERSION = "Demo version 3."
SAMPLE_RATE = 22_050
TEMPO_BPM = 92.0
BEAT_SECONDS = 60 / TEMPO_BPM


@dataclass(frozen=True)
class DemoNote:
    beat: float
    duration: float
    midi: int
    bend: float = 0
    vibrato: bool = False
    confidence: float = 0.9


DEMO_NOTES = [
    DemoNote(2.0, 1.2, 64, confidence=0.94),
    DemoNote(3.5, 0.45, 67, confidence=0.91),
    DemoNote(4.0, 1.4, 69, bend=180, confidence=0.72),
    DemoNote(6.0, 0.5, 67, confidence=0.88),
    DemoNote(6.65, 0.5, 64, confidence=0.86),
    DemoNote(7.4, 1.7, 62, vibrato=True, confidence=0.67),
    DemoNote(10.0, 0.42, 64, confidence=0.92),
    DemoNote(10.55, 0.42, 67, confidence=0.9),
    DemoNote(11.1, 0.42, 69, confidence=0.88),
    DemoNote(11.7, 1.25, 71, bend=95, confidence=0.78),
    DemoNote(14.0, 0.6, 69, confidence=0.84),
    DemoNote(14.8, 0.6, 67, confidence=0.86),
    DemoNote(15.6, 0.6, 64, confidence=0.89),
    DemoNote(16.4, 1.8, 62, vibrato=True, confidence=0.63),
    DemoNote(19.0, 0.5, 57, confidence=0.87),
    DemoNote(19.7, 0.5, 62, confidence=0.85),
    DemoNote(20.4, 2.6, 64, bend=110, vibrato=True, confidence=0.7),
]


def _envelope(length: int, attack: int, release: int) -> np.ndarray:
    envelope = np.ones(length, dtype=np.float64)
    attack = min(attack, length)
    release = min(release, length)
    if attack:
        envelope[:attack] = np.linspace(0, 1, attack)
    if release:
        envelope[-release:] *= np.linspace(1, 0, release)
    return envelope


def _guitar_tone(note: DemoNote) -> tuple[np.ndarray, list[float]]:
    seconds = note.duration * BEAT_SECONDS
    length = max(1, round(seconds * SAMPLE_RATE))
    time = np.arange(length) / SAMPLE_RATE
    bend_progress = np.clip((time / max(seconds, 0.01) - 0.18) / 0.42, 0, 1)
    bend_cents = note.bend * np.sin(bend_progress * math.pi / 2) ** 2
    if note.vibrato:
        bend_cents += 22 * np.sin(2 * math.pi * 5.3 * time) * np.clip(time / 0.3, 0, 1)
    frequency = 440 * 2 ** ((note.midi - 69 + bend_cents / 100) / 12)
    phase = 2 * math.pi * np.cumsum(frequency) / SAMPLE_RATE
    signal = (
        np.sin(phase)
        + 0.48 * np.sin(2 * phase + 0.2)
        + 0.23 * np.sin(3 * phase + 0.65)
        + 0.1 * np.sin(4 * phase)
    )
    pick = np.random.default_rng(note.midi + round(note.beat * 10)).normal(0, 1, length)
    pick *= np.exp(-time * 18) * 0.08
    decay = np.exp(-time * (1.05 if note.duration > 1 else 2.1))
    signal = (signal * decay + pick) * _envelope(length, 90, min(length // 3, 1200))
    signal = np.tanh(signal * 1.3) * 0.25
    curve_indexes = np.linspace(0, length - 1, min(24, length), dtype=int)
    return signal.astype(np.float32), bend_cents[curve_indexes].round(1).tolist()


def _pad_chord(root_midi: int, length: int) -> np.ndarray:
    time = np.arange(length) / SAMPLE_RATE
    signal = np.zeros(length)
    for semitones, gain in ((0, 1), (7, 0.55), (12, 0.35), (16, 0.2)):
        frequency = 440 * 2 ** ((root_midi + semitones - 69) / 12)
        signal += np.sin(2 * math.pi * frequency * time) * gain
    return signal * _envelope(length, 1800, 2500) * 0.055


def _write_wave(path: Path, audio: np.ndarray) -> None:
    clipped = np.clip(audio, -0.99, 0.99)
    pcm = (clipped * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())


def _render_demo(directory: Path) -> tuple[float, list[NoteEvent]]:
    duration_s = 18.0
    length = round(duration_s * SAMPLE_RATE)
    backing = np.zeros((length, 2), dtype=np.float32)
    lead = np.zeros((length, 2), dtype=np.float32)

    bar_length = round(BEAT_SECONDS * 4 * SAMPLE_RATE)
    chord_roots = [45, 41, 48, 43, 45, 41, 48]
    for bar, root in enumerate(chord_roots):
        start = bar * bar_length
        if start >= length:
            break
        end = min(length, start + bar_length)
        pad = _pad_chord(root, end - start).astype(np.float32)
        backing[start:end, 0] += pad * 0.92
        backing[start:end, 1] += pad * 1.08

    rng = np.random.default_rng(42)
    beat_count = math.ceil(duration_s / BEAT_SECONDS)
    for beat in range(beat_count):
        start = round(beat * BEAT_SECONDS * SAMPLE_RATE)
        if start >= length:
            continue
        kick_length = min(round(0.16 * SAMPLE_RATE), length - start)
        time = np.arange(kick_length) / SAMPLE_RATE
        kick = np.sin(2 * math.pi * (78 - 36 * time) * time) * np.exp(-time * 19) * 0.18
        backing[start : start + kick_length] += kick[:, None]
        if beat % 2 == 1:
            noise_length = min(round(0.12 * SAMPLE_RATE), length - start)
            noise = rng.normal(0, 1, noise_length) * np.exp(
                -np.arange(noise_length) / SAMPLE_RATE * 28
            )
            backing[start : start + noise_length] += noise[:, None] * 0.05

    raw_notes: list[NoteEvent] = []
    for index, spec in enumerate(DEMO_NOTES):
        start_s = spec.beat * BEAT_SECONDS
        if start_s >= duration_s:
            break
        start = round(start_s * SAMPLE_RATE)
        tone, curve = _guitar_tone(spec)
        tone = tone[: length - start]
        pan = 0.08 * math.sin(index)
        lead[start : start + len(tone), 0] += tone * (1 - pan)
        lead[start : start + len(tone), 1] += tone * (1 + pan)
        techniques: list[str] = []
        if spec.bend:
            techniques.append("bend")
        if spec.vibrato:
            techniques.append("vibrato")
        end = start + len(tone)
        raw_notes.append(
            NoteEvent(
                id=f"note-{index + 1}",
                onset_frame=start,
                end_frame=end,
                audio_onset_s=start / SAMPLE_RATE,
                audio_offset_s=end / SAMPLE_RATE,
                score_tick=round(spec.beat * 480),
                duration_ticks=max(60, round(spec.duration * 480)),
                midi_pitch=spec.midi,
                pitch_curve_cents=curve,
                string=1,
                fret=max(0, spec.midi - 64),
                techniques=techniques,
                confidence=Confidence(
                    pitch=spec.confidence,
                    onset=min(0.98, spec.confidence + 0.07),
                    fingering=0.5,
                    technique=0.82 if techniques else 0.9,
                ),
            )
        )

    notes = assign_fingerings(raw_notes, [40, 45, 50, 55, 59, 64], 22)
    mix = backing + lead
    peak = max(float(np.abs(mix).max()), 0.01)
    mix *= 0.82 / peak
    backing *= 0.82 / peak
    lead *= 0.82 / peak
    _write_wave(directory / "original.wav", mix)
    _write_wave(directory / "lead.wav", lead)
    _write_wave(directory / "backing.wav", backing)
    return duration_s, notes


def ensure_demo(store: ProjectStore) -> Project:
    existing = store.get(DEMO_ID)
    directory = store.project_dir(DEMO_ID)
    required = [directory / name for name in ("original.wav", "lead.wav", "backing.wav")]

    def media_is_valid(path: Path) -> bool:
        try:
            with wave.open(str(path), "rb") as audio_file:
                return (
                    audio_file.getnchannels() == 2
                    and audio_file.getframerate() == SAMPLE_RATE
                    and audio_file.getnframes() == round(18.0 * SAMPLE_RATE)
                )
        except (EOFError, OSError, wave.Error):
            return False

    if (
        existing
        and DEMO_VERSION in existing.provenance
        and all(media_is_valid(path) for path in required)
    ):
        return existing

    duration_s, notes = _render_demo(directory)
    refreshed_peaks = waveform_peaks(directory / "original.wav")
    if existing is not None:
        provenance = [
            DEMO_VERSION,
            *[item for item in existing.provenance if not item.startswith("Demo version ")],
        ]
        refreshed = existing.model_copy(
            update={
                "duration_s": duration_s,
                "waveform_peaks": refreshed_peaks,
                "provenance": provenance,
            }
        )
        return store.put(refreshed, reason="refresh demo media")
    anchors = [
        SyncAnchor(
            audio_frame=round(beat * BEAT_SECONDS * SAMPLE_RATE),
            score_tick=beat * 480,
        )
        for beat in range(math.ceil(duration_s / BEAT_SECONDS) + 1)
    ]
    assets = [
        MediaAsset(
            role=role,
            url=f"/media/{DEMO_ID}/{role if role != 'original' else 'original'}.wav",
            filename=f"{role if role != 'original' else 'original'}.wav",
            duration_s=duration_s,
            sample_rate=SAMPLE_RATE,
            method="Exact synthetic stem",
        )
        for role in ("original", "lead", "backing")
    ]
    stages = [
        PipelineStage(id="separate", label="Separate guitar", status=StageState.complete),
        PipelineStage(id="hear", label="Hear notes", status=StageState.complete),
        PipelineStage(id="rhythm", label="Match rhythm", status=StageState.complete),
        PipelineStage(id="fingering", label="Choose frets", status=StageState.complete),
    ]
    project = Project(
        id=DEMO_ID,
        title="Northbound Lights",
        artist="SoloTrace demo",
        duration_s=duration_s,
        passage=Passage(name="Solo 1", start_s=1.0, end_s=16.8),
        assets=assets,
        tab=TabDocument(
            sample_rate=SAMPLE_RATE,
            tempo_bpm=TEMPO_BPM,
            sync_anchors=anchors,
            notes=notes,
        ),
        run=ProcessingRun(
            id="demo-run",
            state=RunState.complete,
            stages=stages,
            message="Draft ready",
        ),
        source_name="Generated locally",
        demo=True,
        separation_scope="exact",
        waveform_peaks=refreshed_peaks,
        provenance=[
            DEMO_VERSION,
            "Synthetic lead, backing, and note labels generated locally.",
            "No copyrighted recording or cloud service is used.",
        ],
    )
    return store.put(project, reason="create demo")
