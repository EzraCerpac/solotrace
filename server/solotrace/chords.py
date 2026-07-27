from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import uniform_filter1d

from .models import (
    ChordAlternative,
    ChordEvent,
    ChordQuality,
    ChordTrack,
    Project,
    SpelledPitch,
    TabDocument,
)
from .timing import audio_frame_to_score_tick

MODEL_REVISION = "fbd620e6a7617bbc82795b1f0c828a7721c213f4"
MODEL_SHA256 = "9a6570bf611cdc3f2c36286307af46fb94927fe7f6a2bc22a87c0ebf5f6c082e"
CONFIG_SHA256 = "1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4"
ENGINE_NAME = "ChordMini 2E1D ONNX"
CHUNK_SECONDS = 5 * 60
QUALITIES: tuple[ChordQuality, ...] = (
    "min",
    "maj",
    "dim",
    "aug",
    "min6",
    "maj6",
    "min7",
    "minmaj7",
    "maj7",
    "7",
    "dim7",
    "hdim7",
    "sus2",
    "sus4",
)

_RESOURCE_DIR = Path(__file__).resolve().parent / "resources" / "chordmini"
_MODEL_PATH = _RESOURCE_DIR / "chordnet.onnx"
_CONFIG_PATH = _RESOURCE_DIR / "config.json"


class ChordRecognitionCancelled(RuntimeError):
    pass


class ChordRecognitionUnavailable(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def model_config() -> dict[str, object]:
    if not _CONFIG_PATH.is_file() or _sha256(_CONFIG_PATH) != CONFIG_SHA256:
        raise ChordRecognitionUnavailable(
            "ChordMini vocabulary configuration is missing or damaged"
        )
    config = json.loads(_CONFIG_PATH.read_text())
    expected = {
        "seqLen": 108,
        "sampleRate": 22050,
        "hopLength": 2048,
        "nBins": 144,
        "binsPerOctave": 24,
        "smoothingKernel": 9,
        "numChords": 170,
    }
    if any(config.get(key) != value for key, value in expected.items()):
        raise ChordRecognitionUnavailable("ChordMini preprocessing configuration does not match")
    vocabulary = config.get("chordVocab")
    if not isinstance(vocabulary, list) or len(vocabulary) != 170:
        raise ChordRecognitionUnavailable("ChordMini vocabulary must contain 170 labels")
    return config


@lru_cache(maxsize=1)
def _model_status() -> tuple[bool, str]:
    try:
        model_config()
        if not _MODEL_PATH.is_file() or _sha256(_MODEL_PATH) != MODEL_SHA256:
            return False, "Pinned ChordMini model is missing or damaged"
        import onnxruntime  # noqa: F401
    except (ImportError, ChordRecognitionUnavailable) as error:
        return False, str(error) or "ONNX Runtime is unavailable"
    return True, "Pinned model verified for offline recognition"


def recognition_capability() -> dict[str, object]:
    available, detail = _model_status()
    return {
        "available": available,
        "engine": ENGINE_NAME,
        "modelRevision": MODEL_REVISION,
        "modelSha256": MODEL_SHA256,
        "detail": detail,
        "desktopOnly": True,
    }


@lru_cache(maxsize=1)
def _session():
    available, detail = _model_status()
    if not available:
        raise ChordRecognitionUnavailable(detail)
    import onnxruntime as ort

    return ort.InferenceSession(
        str(_MODEL_PATH),
        providers=["CPUExecutionProvider"],
    )


def _spelled_pitch(label: str) -> SpelledPitch:
    step = label[0]
    accidental = label[1:]
    return SpelledPitch(step=step, alter={"bb": -2, "b": -1, "": 0, "#": 1, "##": 2}[accidental])


def _label_parts(label: str) -> tuple[str, SpelledPitch | None, ChordQuality | None]:
    if label == "N":
        return "no-chord", None, None
    if label == "X":
        return "unknown", None, None
    root_text, separator, quality_text = label.partition(":")
    quality: ChordQuality = "maj" if not separator else quality_text  # type: ignore[assignment]
    if quality not in QUALITIES:
        raise ValueError(f"Unsupported ChordMini quality: {quality}")
    return "chord", _spelled_pitch(root_text), quality


def chord_symbol(event: ChordEvent) -> str:
    if event.kind == "no-chord":
        return "N.C."
    if event.kind == "unknown":
        return "X"
    assert event.root is not None and event.quality is not None
    accidental = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}[event.root.alter]
    suffix = {
        "maj": "",
        "min": "m",
        "dim": "dim",
        "aug": "aug",
        "min6": "m6",
        "maj6": "6",
        "min7": "m7",
        "minmaj7": "m(maj7)",
        "maj7": "maj7",
        "7": "7",
        "dim7": "dim7",
        "hdim7": "m7b5",
        "sus2": "sus2",
        "sus4": "sus4",
    }[event.quality]
    bass = ""
    if event.bass is not None:
        bass_accidental = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}[event.bass.alter]
        bass = f"/{event.bass.step}{bass_accidental}"
    return f"{event.root.step}{accidental}{suffix}{bass}"


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits, axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def _infer_features(features: np.ndarray) -> np.ndarray:
    config = model_config()
    sequence_length = int(config["seqLen"])
    frame_count = features.shape[0]
    padded_count = ((frame_count + sequence_length - 1) // sequence_length) * sequence_length
    padded = np.pad(
        features.astype(np.float32, copy=False),
        ((0, padded_count - frame_count), (0, 0)),
        mode="constant",
    )
    windows = padded.reshape(-1, sequence_length, features.shape[1])
    logits = _session().run(["logits"], {"features": windows})[0]
    return logits.reshape(-1, logits.shape[-1])[:frame_count]


def _chunk_predictions(
    audio_path: Path,
    start_s: float,
    end_s: float,
    *,
    cancelled: Callable[[], bool],
) -> tuple[np.ndarray, np.ndarray]:
    config = model_config()
    sample_rate = int(config["sampleRate"])
    hop_length = int(config["hopLength"])
    sequence_length = int(config["seqLen"])
    overlap_s = sequence_length * hop_length / sample_rate
    frame_times: list[np.ndarray] = []
    frame_logits: list[np.ndarray] = []
    cursor = start_s
    while cursor < end_s - 1e-9:
        if cancelled():
            raise ChordRecognitionCancelled("Chord recognition cancelled")
        core_end = min(end_s, cursor + CHUNK_SECONDS)
        read_start = max(start_s, cursor - overlap_s)
        read_end = min(end_s, core_end + overlap_s)
        audio, _ = librosa.load(
            audio_path,
            sr=sample_rate,
            mono=True,
            offset=read_start,
            duration=read_end - read_start,
        )
        if cancelled():
            raise ChordRecognitionCancelled("Chord recognition cancelled")
        cqt = librosa.cqt(
            audio,
            sr=sample_rate,
            hop_length=hop_length,
            fmin=float(config["fmin"]),
            n_bins=int(config["nBins"]),
            bins_per_octave=int(config["binsPerOctave"]),
            norm=1,
            sparsity=0.01,
            window="hann",
            scale=True,
            pad_mode="constant",
        )
        features = np.log(np.abs(cqt).T + 1e-6).astype(np.float32)
        logits = _infer_features(features)
        times = read_start + librosa.frames_to_time(
            np.arange(features.shape[0]),
            sr=sample_rate,
            hop_length=hop_length,
        )
        keep = (times >= cursor - 1e-9) & (
            (times < core_end - 1e-9) if core_end < end_s else (times <= core_end + 1e-9)
        )
        frame_times.append(times[keep])
        frame_logits.append(logits[keep])
        cursor = core_end
    if not frame_times or not any(part.size for part in frame_times):
        raise RuntimeError("ChordMini produced no analyzable frames")
    times = np.concatenate(frame_times)
    logits = np.concatenate(frame_logits)
    order = np.argsort(times, kind="stable")
    times = times[order]
    logits = logits[order]
    unique = np.concatenate(([True], np.diff(times) > 1e-6))
    return times[unique], logits[unique]


def _event_from_segment(
    label_index: int,
    segment_logits: np.ndarray,
    onset_s: float,
    offset_s: float,
    tab: TabDocument,
) -> ChordEvent:
    vocabulary = model_config()["chordVocab"]
    assert isinstance(vocabulary, list)
    probabilities = _softmax(segment_logits)
    mean_scores = probabilities.mean(axis=0)
    top_indices = np.argsort(mean_scores)[::-1][:3]
    kind, root, quality = _label_parts(str(vocabulary[label_index]))
    alternatives = []
    for index in top_indices:
        alternative_kind, alternative_root, alternative_quality = _label_parts(
            str(vocabulary[int(index)])
        )
        alternatives.append(
            ChordAlternative(
                kind=alternative_kind,
                root=alternative_root,
                quality=alternative_quality,
                model_score=float(mean_scores[index]),
            )
        )
    onset_frame = round(onset_s * tab.sample_rate)
    end_frame = max(onset_frame + 1, round(offset_s * tab.sample_rate))
    score_tick = audio_frame_to_score_tick(onset_frame, tab.sync_anchors)
    end_tick = audio_frame_to_score_tick(end_frame, tab.sync_anchors)
    return ChordEvent(
        id=f"chord-{uuid.uuid4().hex[:12]}",
        onset_frame=onset_frame,
        end_frame=end_frame,
        audio_onset_s=onset_s,
        audio_offset_s=offset_s,
        score_tick=score_tick,
        duration_ticks=max(1, end_tick - score_tick),
        kind=kind,
        root=root,
        quality=quality,
        model_score=float(mean_scores[label_index]),
        alternatives=alternatives,
        provenance="detected",
        edited=False,
        reviewed=False,
    )


def recognize_chords(
    audio_path: Path,
    start_s: float,
    end_s: float,
    tab: TabDocument,
    *,
    cancelled: Callable[[], bool] = lambda: False,
) -> ChordTrack:
    available, detail = _model_status()
    if not available:
        raise ChordRecognitionUnavailable(detail)
    times, logits = _chunk_predictions(
        audio_path,
        start_s,
        end_s,
        cancelled=cancelled,
    )
    smoothed = uniform_filter1d(
        logits,
        size=int(model_config()["smoothingKernel"]),
        axis=0,
        mode="nearest",
    )
    labels = np.argmax(smoothed, axis=1)
    events: list[ChordEvent] = []
    segment_start = 0
    for index in range(1, len(labels) + 1):
        if index < len(labels) and labels[index] == labels[segment_start]:
            continue
        onset_s = start_s if segment_start == 0 else float(times[segment_start])
        offset_s = end_s if index == len(labels) else float(times[index])
        if offset_s > onset_s:
            events.append(
                _event_from_segment(
                    int(labels[segment_start]),
                    smoothed[segment_start:index],
                    onset_s,
                    offset_s,
                    tab,
                )
            )
        segment_start = index
    return ChordTrack(
        engine=ENGINE_NAME,
        model_revision=MODEL_REVISION,
        model_sha256=MODEL_SHA256,
        analyzed_start_s=start_s,
        analyzed_end_s=end_s,
        events=events,
    )


def normalize_edited_chords(
    project: Project,
    submitted: ChordTrack,
) -> ChordTrack:
    events = sorted(submitted.events, key=lambda event: (event.audio_onset_s, event.id))
    ids = [event.id for event in events]
    if len(ids) != len(set(ids)):
        raise ValueError("Chord ids must be unique")
    if not events:
        return submitted.model_copy(
            update={
                "engine": submitted.engine or "manual",
                "events": [],
            }
        )
    range_start = submitted.analyzed_start_s
    range_end = submitted.analyzed_end_s
    if range_start is None or range_end is None:
        raise ValueError("A non-empty chord track needs an analyzed range")
    if range_start < project.passage.start_s or range_end > min(
        project.passage.end_s,
        project.duration_s,
    ):
        raise ValueError("Chord range must stay inside the transcription range")
    tolerance = 1e-4
    if abs(events[0].audio_onset_s - range_start) > tolerance:
        raise ValueError("Chord spans must start at the analyzed range")
    if abs(events[-1].audio_offset_s - range_end) > tolerance:
        raise ValueError("Chord spans must end at the analyzed range")
    normalized: list[ChordEvent] = []
    for index, event in enumerate(events):
        if index and abs(events[index - 1].audio_offset_s - event.audio_onset_s) > tolerance:
            raise ValueError("Chord spans must be contiguous and cannot overlap")
        onset_s = range_start if index == 0 else normalized[-1].audio_offset_s
        offset_s = range_end if index == len(events) - 1 else event.audio_offset_s
        if offset_s <= onset_s:
            raise ValueError("Chord spans must have positive duration")
        onset_frame = round(onset_s * project.tab.sample_rate)
        end_frame = max(onset_frame + 1, round(offset_s * project.tab.sample_rate))
        score_tick = audio_frame_to_score_tick(onset_frame, project.tab.sync_anchors)
        end_tick = audio_frame_to_score_tick(end_frame, project.tab.sync_anchors)
        normalized.append(
            event.model_copy(
                update={
                    "onset_frame": onset_frame,
                    "end_frame": end_frame,
                    "audio_onset_s": onset_s,
                    "audio_offset_s": offset_s,
                    "score_tick": score_tick,
                    "duration_ticks": max(1, end_tick - score_tick),
                }
            )
        )
    return submitted.model_copy(update={"events": normalized})
