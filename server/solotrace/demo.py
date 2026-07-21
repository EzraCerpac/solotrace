from __future__ import annotations

import json
import math
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .audio import waveform_peaks
from .fingering import FingeringMode, assign_fingerings
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
    TabVersion,
    now_iso,
)
from .storage import ProjectStore

DEMO_ID = "northbound-lights-demo"
DEMO_VERSION = "Demo version 3."
SAMPLE_RATE = 22_050
TEMPO_BPM = 92.0
BEAT_SECONDS = 60 / TEMPO_BPM
GENERATED_AT = "2026-07-21T00:00:00+00:00"
CC0_PROVENANCE = (
    "Original SoloTrace synthetic melody and audio, dedicated to CC0 1.0.",
    "Generated deterministically by SoloTrace; no recording, cloud service, "
    "or runtime compute used.",
)


@dataclass(frozen=True)
class DemoNote:
    """A note in quarter-note beats, independent of the rendered sample rate."""

    beat: float
    duration: float
    midi: int
    bend: float = 0
    vibrato: bool = False
    confidence: float = 0.9
    techniques: tuple[str, ...] = ()


@dataclass(frozen=True)
class ExampleVersionSpec:
    id_suffix: str
    name: str
    mode: FingeringMode


@dataclass(frozen=True)
class ExampleSpec:
    slug: str
    project_id: str
    title: str
    summary: str
    tempo_bpm: float
    time_signature: tuple[int, int]
    tuning: tuple[int, ...]
    tuning_label: str
    duration_s: float
    passage: tuple[float, float]
    notes: tuple[DemoNote, ...]
    chord_roots: tuple[int, ...]
    versions: tuple[ExampleVersionSpec, ...]
    percussion_seed: int

    @property
    def beat_seconds(self) -> float:
        return 60 / self.tempo_bpm

    @property
    def bar_quarter_beats(self) -> float:
        numerator, denominator = self.time_signature
        return numerator * 4 / denominator


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


NORTHBOUND_LIGHTS = ExampleSpec(
    slug="northbound-lights",
    project_id=DEMO_ID,
    title="Northbound Lights",
    summary="A spacious melodic solo with expressive bends, vibrato, and notes to review.",
    tempo_bpm=TEMPO_BPM,
    time_signature=(4, 4),
    tuning=(40, 45, 50, 55, 59, 64),
    tuning_label="Standard",
    duration_s=18.0,
    passage=(1.0, 16.8),
    notes=tuple(DEMO_NOTES),
    chord_roots=(45, 41, 48, 43, 45, 41, 48),
    versions=(ExampleVersionSpec("balanced", "Balanced", "balanced"),),
    percussion_seed=42,
)

SWITCHBACK_RUN = ExampleSpec(
    slug="switchback-run",
    project_id="switchback-run-demo",
    title="Switchback Run",
    summary="A quick legato line for tracing hammer-ons, pull-offs, and connecting slides.",
    tempo_bpm=144.0,
    time_signature=(4, 4),
    tuning=(40, 45, 50, 55, 59, 64),
    tuning_label="Standard",
    duration_s=14.0,
    passage=(0.35, 13.4),
    notes=(
        DemoNote(1.0, 0.44, 64, confidence=0.95),
        DemoNote(1.45, 0.38, 67, confidence=0.94, techniques=("hammer-on",)),
        DemoNote(1.85, 0.38, 69, confidence=0.93, techniques=("hammer-on",)),
        DemoNote(2.25, 0.48, 67, confidence=0.91, techniques=("pull-off",)),
        DemoNote(3.0, 0.55, 71, confidence=0.9, techniques=("slide",)),
        DemoNote(3.6, 0.34, 72, confidence=0.93, techniques=("hammer-on",)),
        DemoNote(3.96, 0.34, 74, confidence=0.92, techniques=("hammer-on",)),
        DemoNote(4.34, 0.46, 72, confidence=0.9, techniques=("pull-off",)),
        DemoNote(5.0, 0.4, 69, confidence=0.92, techniques=("slide",)),
        DemoNote(5.45, 0.33, 72, confidence=0.94, techniques=("hammer-on",)),
        DemoNote(5.8, 0.33, 74, confidence=0.92, techniques=("hammer-on",)),
        DemoNote(6.15, 0.52, 72, confidence=0.89, techniques=("pull-off",)),
        DemoNote(7.0, 0.42, 67, confidence=0.91, techniques=("slide",)),
        DemoNote(7.45, 0.33, 69, confidence=0.93, techniques=("hammer-on",)),
        DemoNote(7.8, 0.33, 72, confidence=0.9, techniques=("hammer-on",)),
        DemoNote(8.15, 0.5, 69, confidence=0.88, techniques=("pull-off",)),
        DemoNote(9.0, 0.38, 64, confidence=0.93, techniques=("slide",)),
        DemoNote(9.42, 0.34, 67, confidence=0.92, techniques=("hammer-on",)),
        DemoNote(9.78, 0.34, 69, confidence=0.91, techniques=("hammer-on",)),
        DemoNote(10.15, 0.48, 67, confidence=0.89, techniques=("pull-off",)),
        DemoNote(11.0, 0.42, 62, confidence=0.92, techniques=("slide",)),
        DemoNote(11.45, 0.35, 64, confidence=0.93, techniques=("hammer-on",)),
        DemoNote(11.82, 0.35, 67, confidence=0.92, techniques=("hammer-on",)),
        DemoNote(12.2, 0.7, 64, confidence=0.87, techniques=("pull-off",)),
    ),
    chord_roots=(40, 43, 45, 38, 40, 43, 45, 47, 40),
    versions=(ExampleVersionSpec("balanced", "Balanced", "balanced"),),
    percussion_seed=144,
)

LOW_ORBIT = ExampleSpec(
    slug="low-orbit",
    project_id="low-orbit-demo",
    title="Low Orbit",
    summary="A Drop D phrase in 6/8 with three playable fingering approaches to compare.",
    tempo_bpm=96.0,
    time_signature=(6, 8),
    tuning=(38, 45, 50, 55, 59, 64),
    tuning_label="Drop D",
    duration_s=18.0,
    passage=(0.7, 17.2),
    notes=(
        DemoNote(1.0, 1.0, 38, confidence=0.96),
        DemoNote(2.0, 0.5, 45, confidence=0.94),
        DemoNote(2.5, 0.5, 60, confidence=0.93),
        DemoNote(3.0, 1.2, 61, confidence=0.9, techniques=("slide",)),
        DemoNote(4.5, 0.55, 60, confidence=0.92),
        DemoNote(5.1, 0.55, 65, confidence=0.91),
        DemoNote(5.7, 0.9, 70, confidence=0.89, vibrato=True),
        DemoNote(7.0, 0.6, 68, confidence=0.94),
        DemoNote(7.65, 0.6, 73, confidence=0.92),
        DemoNote(8.3, 0.9, 74, confidence=0.9, techniques=("hammer-on",)),
        DemoNote(10.0, 0.6, 74, confidence=0.95),
        DemoNote(10.65, 0.6, 71, confidence=0.93),
        DemoNote(11.3, 1.0, 73, confidence=0.9, techniques=("slide",)),
        DemoNote(13.0, 0.55, 74, confidence=0.93),
        DemoNote(13.6, 0.55, 71, confidence=0.91),
        DemoNote(14.2, 0.85, 72, confidence=0.88, techniques=("hammer-on",)),
        DemoNote(15.5, 0.65, 69, confidence=0.91, techniques=("pull-off",)),
        DemoNote(16.2, 1.2, 38, confidence=0.89),
    ),
    chord_roots=(38, 43, 45, 38, 41, 43, 38),
    versions=(
        ExampleVersionSpec("balanced", "Balanced", "balanced"),
        ExampleVersionSpec("easiest", "Easiest", "easiest"),
        ExampleVersionSpec("one-position", "One Position", "position"),
    ),
    percussion_seed=96,
)

EXAMPLE_SPECS = (NORTHBOUND_LIGHTS, SWITCHBACK_RUN, LOW_ORBIT)


def _envelope(length: int, attack: int, release: int) -> np.ndarray:
    envelope = np.ones(length, dtype=np.float64)
    attack = min(attack, length)
    release = min(release, length)
    if attack:
        envelope[:attack] = np.linspace(0, 1, attack)
    if release:
        envelope[-release:] *= np.linspace(1, 0, release)
    return envelope


def _guitar_tone(
    note: DemoNote,
    *,
    previous_note: DemoNote | None,
    beat_seconds: float,
    sample_rate: int,
    seed_offset: int = 0,
) -> tuple[np.ndarray, list[float]]:
    seconds = note.duration * beat_seconds
    length = max(1, round(seconds * sample_rate))
    time = np.arange(length) / sample_rate
    bend_progress = np.clip((time / max(seconds, 0.01) - 0.18) / 0.42, 0, 1)
    bend_cents = note.bend * np.sin(bend_progress * math.pi / 2) ** 2
    if any(technique in {"slide", "slide-up", "slide-down"} for technique in note.techniques):
        if previous_note is None:
            raise ValueError("a slide destination requires a previous note")
        slide_progress = np.clip(time / max(seconds * 0.42, 0.01), 0, 1)
        incoming_cents = (previous_note.midi - note.midi) * 100
        bend_cents += incoming_cents * (
            1 - np.sin(slide_progress * math.pi / 2) ** 2
        )
    if note.vibrato:
        bend_cents += 22 * np.sin(2 * math.pi * 5.3 * time) * np.clip(time / 0.3, 0, 1)
    frequency = 440 * 2 ** ((note.midi - 69 + bend_cents / 100) / 12)
    phase = 2 * math.pi * np.cumsum(frequency) / sample_rate
    signal = (
        np.sin(phase)
        + 0.48 * np.sin(2 * phase + 0.2)
        + 0.23 * np.sin(3 * phase + 0.65)
        + 0.1 * np.sin(4 * phase)
    )
    seed = seed_offset + note.midi + round(note.beat * 10)
    pick = np.random.default_rng(seed).normal(0, 1, length)
    pick_gain = 0.025 if {"hammer-on", "pull-off"} & set(note.techniques) else 0.08
    pick *= np.exp(-time * 18) * pick_gain
    decay = np.exp(-time * (1.05 if note.duration > 1 else 2.1))
    signal = (signal * decay + pick) * _envelope(length, 90, min(length // 3, 1200))
    signal = np.tanh(signal * 1.3) * 0.25
    curve_indexes = np.linspace(0, length - 1, min(24, length), dtype=int)
    return signal.astype(np.float32), bend_cents[curve_indexes].round(1).tolist()


def _pad_chord(root_midi: int, length: int, sample_rate: int) -> np.ndarray:
    time = np.arange(length) / sample_rate
    signal = np.zeros(length)
    for semitones, gain in ((0, 1), (7, 0.55), (12, 0.35), (16, 0.2)):
        frequency = 440 * 2 ** ((root_midi + semitones - 69) / 12)
        signal += np.sin(2 * math.pi * frequency * time) * gain
    return signal * _envelope(length, 1800, 2500) * 0.055


def _write_pcm_wave(path: Path, pcm: np.ndarray, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.astype("<i2", copy=False).tobytes())


def _write_exact_stems(
    directory: Path,
    lead: np.ndarray,
    backing: np.ndarray,
    sample_rate: int,
) -> None:
    mix = lead + backing
    peak = max(float(np.abs(mix).max()), 0.01)
    scale = 0.82 / peak * 32767
    lead_pcm = np.rint(lead * scale).astype(np.int32)
    backing_pcm = np.rint(backing * scale).astype(np.int32)
    mix_pcm = lead_pcm + backing_pcm
    if np.max(np.abs(mix_pcm)) > 32767:
        raise ValueError("synthetic mix exceeded the PCM range")
    _write_pcm_wave(directory / "original.wav", mix_pcm, sample_rate)
    _write_pcm_wave(directory / "lead.wav", lead_pcm, sample_rate)
    _write_pcm_wave(directory / "backing.wav", backing_pcm, sample_rate)


def _render_example(directory: Path, spec: ExampleSpec) -> list[NoteEvent]:
    directory.mkdir(parents=True, exist_ok=True)
    length = round(spec.duration_s * SAMPLE_RATE)
    backing = np.zeros((length, 2), dtype=np.float32)
    lead = np.zeros((length, 2), dtype=np.float32)

    bar_length = round(spec.beat_seconds * spec.bar_quarter_beats * SAMPLE_RATE)
    for bar, root in enumerate(spec.chord_roots):
        start = bar * bar_length
        if start >= length:
            break
        end = min(length, start + bar_length)
        pad = _pad_chord(root, end - start, SAMPLE_RATE).astype(np.float32)
        backing[start:end, 0] += pad * 0.92
        backing[start:end, 1] += pad * 1.08

    rng = np.random.default_rng(spec.percussion_seed)
    pulse_seconds = spec.beat_seconds if spec.time_signature == (4, 4) else spec.beat_seconds / 2
    pulse_count = math.ceil(spec.duration_s / pulse_seconds)
    for pulse in range(pulse_count):
        start = round(pulse * pulse_seconds * SAMPLE_RATE)
        if start >= length:
            continue
        kick_length = min(round(0.16 * SAMPLE_RATE), length - start)
        time = np.arange(kick_length) / SAMPLE_RATE
        kick = np.sin(2 * math.pi * (78 - 36 * time) * time) * np.exp(-time * 19) * 0.18
        backing[start : start + kick_length] += kick[:, None]
        if pulse % 2 == 1:
            noise_length = min(round(0.12 * SAMPLE_RATE), length - start)
            noise = rng.normal(0, 1, noise_length) * np.exp(
                -np.arange(noise_length) / SAMPLE_RATE * 28
            )
            backing[start : start + noise_length] += noise[:, None] * 0.05

    raw_notes: list[NoteEvent] = []
    for index, note_spec in enumerate(spec.notes):
        start_s = note_spec.beat * spec.beat_seconds
        if start_s >= spec.duration_s:
            break
        start = round(start_s * SAMPLE_RATE)
        tone, curve = _guitar_tone(
            note_spec,
            previous_note=spec.notes[index - 1] if index > 0 else None,
            beat_seconds=spec.beat_seconds,
            sample_rate=SAMPLE_RATE,
            seed_offset=spec.percussion_seed * 100,
        )
        tone = tone[: length - start]
        pan = 0.08 * math.sin(index)
        lead[start : start + len(tone), 0] += tone * (1 - pan)
        lead[start : start + len(tone), 1] += tone * (1 + pan)
        techniques = list(note_spec.techniques)
        if note_spec.bend:
            techniques.append("bend")
        if note_spec.vibrato:
            techniques.append("vibrato")
        end = start + len(tone)
        raw_notes.append(
            NoteEvent(
                id=f"{spec.slug}-note-{index + 1:02d}",
                onset_frame=start,
                end_frame=end,
                audio_onset_s=start / SAMPLE_RATE,
                audio_offset_s=end / SAMPLE_RATE,
                score_tick=round(note_spec.beat * 480),
                duration_ticks=max(60, round(note_spec.duration * 480)),
                midi_pitch=note_spec.midi,
                pitch_curve_cents=curve,
                string=1,
                fret=max(0, note_spec.midi - spec.tuning[-1]),
                techniques=techniques,
                confidence=Confidence(
                    pitch=note_spec.confidence,
                    onset=min(0.98, note_spec.confidence + 0.07),
                    fingering=0.5,
                    technique=0.82 if techniques else 0.9,
                ),
            )
        )

    _write_exact_stems(directory, lead, backing, SAMPLE_RATE)
    return raw_notes


def _anchors(spec: ExampleSpec) -> list[SyncAnchor]:
    beat_count = math.floor(spec.duration_s / spec.beat_seconds)
    anchors = [
        SyncAnchor(
            audio_frame=round(beat * spec.beat_seconds * SAMPLE_RATE),
            score_tick=beat * 480,
        )
        for beat in range(beat_count + 1)
    ]
    final_frame = round(spec.duration_s * SAMPLE_RATE)
    if anchors[-1].audio_frame < final_frame:
        anchors.append(
            SyncAnchor(
                audio_frame=final_frame,
                score_tick=round(spec.duration_s / spec.beat_seconds * 480),
            )
        )
    return anchors


def render_example_project(
    spec: ExampleSpec,
    directory: Path,
    *,
    media_url_prefix: str,
) -> Project:
    """Render one deterministic example and return its validated project document."""
    raw_notes = _render_example(directory, spec)
    anchors = _anchors(spec)
    versions = []
    for version_spec in spec.versions:
        notes = assign_fingerings(
            raw_notes,
            list(spec.tuning),
            22,
            mode=version_spec.mode,
        )
        versions.append(
            TabVersion(
                id=f"{spec.slug}-{version_spec.id_suffix}",
                name=version_spec.name,
                source="deterministic example",
                fingering_mode=version_spec.mode,
                created_at=GENERATED_AT,
                updated_at=GENERATED_AT,
                tab=TabDocument(
                    sample_rate=SAMPLE_RATE,
                    tempo_bpm=spec.tempo_bpm,
                    time_signature=spec.time_signature,
                    tuning=list(spec.tuning),
                    sync_anchors=anchors,
                    notes=notes,
                ),
            )
        )
    assets = [
        MediaAsset(
            role=role,
            url=f"{media_url_prefix}/{role}.wav",
            filename=f"{role}.wav",
            duration_s=spec.duration_s,
            sample_rate=SAMPLE_RATE,
            method="Deterministic synthetic stem (CC0-1.0)",
        )
        for role in ("original", "lead", "backing")
    ]
    stages = [
        PipelineStage(id="separate", label="Separate guitar", status=StageState.complete),
        PipelineStage(id="hear", label="Hear notes", status=StageState.complete),
        PipelineStage(id="rhythm", label="Match rhythm", status=StageState.complete),
        PipelineStage(id="fingering", label="Choose frets", status=StageState.complete),
    ]
    return Project(
        id=spec.project_id,
        title=spec.title,
        artist="SoloTrace examples",
        created_at=GENERATED_AT,
        updated_at=GENERATED_AT,
        duration_s=spec.duration_s,
        passage=Passage(name="Example solo", start_s=spec.passage[0], end_s=spec.passage[1]),
        assets=assets,
        versions=versions,
        active_version_id=versions[0].id,
        run=ProcessingRun(
            id=f"{spec.slug}-run",
            state=RunState.complete,
            stages=stages,
            message="Example ready",
            created_at=GENERATED_AT,
            updated_at=GENERATED_AT,
        ),
        source_name="Generated locally",
        demo=True,
        separation_scope="exact",
        waveform_peaks=waveform_peaks(directory / "original.wav"),
        provenance=[
            DEMO_VERSION if spec is NORTHBOUND_LIGHTS else "Hosted example version 1.",
            *CC0_PROVENANCE,
        ],
    )


def write_hosted_examples(output_root: Path) -> list[dict[str, object]]:
    """Generate immutable public assets and return the lightweight gallery catalog."""
    output_root.mkdir(parents=True, exist_ok=True)
    catalog: list[dict[str, object]] = []
    for spec in EXAMPLE_SPECS:
        directory = output_root / spec.slug
        project = render_example_project(
            spec,
            directory,
            media_url_prefix=f"/examples/{spec.slug}",
        )
        document = project.model_dump(
            mode="json",
            include={
                "id",
                "title",
                "artist",
                "created_at",
                "updated_at",
                "revision",
                "duration_s",
                "passage",
                "assets",
                "versions",
                "active_version_id",
                "source_name",
                "waveform_peaks",
                "provenance",
                "separation_scope",
            },
        )
        document.update(origin="example", example_slug=spec.slug)
        (directory / "project.json").write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (directory / "peaks.json").write_text(
            json.dumps(project.waveform_peaks, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        techniques = sorted(
            {technique for note in project.tab.notes for technique in note.techniques}
        )
        catalog.append(
            {
                "slug": spec.slug,
                "title": spec.title,
                "summary": spec.summary,
                "tempoBpm": spec.tempo_bpm,
                "timeSignature": list(spec.time_signature),
                "tuning": list(spec.tuning),
                "tuningLabel": spec.tuning_label,
                "durationS": spec.duration_s,
                "techniques": techniques,
                "versionNames": [version.name for version in spec.versions],
                "projectUrl": f"/examples/{spec.slug}/project.json",
                "peaksUrl": f"/examples/{spec.slug}/peaks.json",
                "audio": {
                    role: f"/examples/{spec.slug}/{role}.wav"
                    for role in ("original", "lead", "backing")
                },
                "license": "CC0-1.0",
                "provenance": list(CC0_PROVENANCE),
            }
        )
    (output_root / "catalog.json").write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return catalog


def ensure_demo(store: ProjectStore) -> Project:
    """Keep the desktop's built-in Northbound Lights demo behavior intact."""
    spec = NORTHBOUND_LIGHTS
    existing = store.get(DEMO_ID)
    directory = store.project_dir(DEMO_ID)
    required = [directory / name for name in ("original.wav", "lead.wav", "backing.wav")]

    def media_is_valid(path: Path) -> bool:
        try:
            with wave.open(str(path), "rb") as audio_file:
                return (
                    audio_file.getnchannels() == 2
                    and audio_file.getframerate() == SAMPLE_RATE
                    and audio_file.getnframes() == round(spec.duration_s * SAMPLE_RATE)
                )
        except (EOFError, OSError, wave.Error):
            return False

    if (
        existing
        and DEMO_VERSION in existing.provenance
        and all(media_is_valid(path) for path in required)
    ):
        return existing

    project = render_example_project(
        spec,
        directory,
        media_url_prefix=f"/media/{DEMO_ID}",
    )
    if existing is not None:
        provenance = [
            DEMO_VERSION,
            *[item for item in existing.provenance if not item.startswith("Demo version ")],
        ]
        refreshed = existing.model_copy(
            update={
                "duration_s": project.duration_s,
                "waveform_peaks": project.waveform_peaks,
                "provenance": provenance,
            }
        )
        return store.put(refreshed, reason="refresh demo media")
    timestamp = now_iso()
    demo_version = project.versions[0].model_copy(
        update={
            "id": "version-demo",
            "name": "Demo tab",
            "source": "demo",
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )
    project = project.model_copy(
        update={
            "created_at": timestamp,
            "updated_at": timestamp,
            "versions": [demo_version],
            "active_version_id": "version-demo",
            "run": project.run.model_copy(
                update={
                    "id": "demo-run",
                    "message": "Draft ready",
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
            ),
            "provenance": [
                DEMO_VERSION,
                "Synthetic lead, backing, and note labels generated locally.",
                "No copyrighted recording or cloud service is used.",
            ],
        }
    )
    return store.put(project, reason="create demo")
