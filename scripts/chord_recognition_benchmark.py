from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path

import librosa
import mir_eval
import numpy as np
import soundfile as sf
from solotrace.chords import MODEL_REVISION, MODEL_SHA256, recognize_chords
from solotrace.models import ChordEvent, TabDocument

METRICS = ("root", "majmin", "triads", "sevenths", "mirex", "seg")
SUPPORTED_QUALITIES = {
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
}


def _pitch_text(event: ChordEvent) -> str:
    assert event.root is not None
    accidental = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}[event.root.alter]
    return f"{event.root.step}{accidental}"


def _event_label(event: ChordEvent) -> str:
    if event.kind == "no-chord":
        return "N"
    if event.kind == "unknown":
        return "X"
    assert event.quality is not None
    return f"{_pitch_text(event)}:{event.quality}"


def _track_intervals(track) -> tuple[np.ndarray, list[str]]:
    return (
        np.asarray(
            [[event.audio_onset_s, event.audio_offset_s] for event in track.events],
            dtype=float,
        ),
        [_event_label(event) for event in track.events],
    )


def _reference(jams_path: Path) -> tuple[np.ndarray, list[str], float]:
    document = json.loads(jams_path.read_text())
    annotations = [
        annotation for annotation in document["annotations"] if annotation["namespace"] == "chord"
    ]
    performed = next(
        (
            annotation
            for annotation in annotations
            if "Semi-automatic" in annotation["annotation_metadata"].get("data_source", "")
        ),
        annotations[-1],
    )
    intervals = np.asarray(
        [
            [observation["time"], observation["time"] + observation["duration"]]
            for observation in performed["data"]
        ],
        dtype=float,
    )
    labels = [str(observation["value"]) for observation in performed["data"]]
    return intervals, labels, float(document["file_metadata"]["duration"])


def _find_audio(audio_root: Path, stem: str) -> Path:
    matches = [
        path
        for path in audio_root.rglob(f"{stem}*.wav")
        if "hex" not in path.name and "pickup" not in path.name
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one mono-mic WAV for {stem}, found {len(matches)}")
    return matches[0]


def _segments_from_frames(
    times: np.ndarray,
    labels: list[str],
    duration: float,
) -> tuple[np.ndarray, list[str]]:
    intervals: list[list[float]] = []
    output: list[str] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index < len(labels) and labels[index] == labels[start]:
            continue
        onset = 0.0 if start == 0 else float(times[start])
        offset = duration if index == len(labels) else float(times[index])
        if offset > onset:
            intervals.append([onset, offset])
            output.append(labels[start])
        start = index
    return np.asarray(intervals, dtype=float), output


def _librosa_baseline(audio_path: Path, duration: float) -> tuple[np.ndarray, list[str]]:
    sample_rate = 22_050
    hop_length = 2_048
    audio, _ = librosa.load(audio_path, sr=sample_rate, mono=True)
    chroma = librosa.feature.chroma_cqt(
        y=audio,
        sr=sample_rate,
        hop_length=hop_length,
        n_chroma=12,
        bins_per_octave=24,
    )
    chroma = np.stack(
        [np.convolve(row, np.ones(9, dtype=float) / 9, mode="same") for row in chroma]
    )
    templates: list[np.ndarray] = []
    labels: list[str] = []
    names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    for root, name in enumerate(names):
        for quality, third in (("maj", 4), ("min", 3)):
            template = np.zeros(12, dtype=float)
            template[[root, (root + third) % 12, (root + 7) % 12]] = (1.0, 0.8, 0.7)
            template /= np.linalg.norm(template)
            templates.append(template)
            labels.append(f"{name}:{quality}")
    template_matrix = np.stack(templates)
    normalized = chroma / np.maximum(np.linalg.norm(chroma, axis=0), 1e-9)
    scores = template_matrix @ normalized
    estimated = [labels[index] for index in np.argmax(scores, axis=0)]
    rms = librosa.feature.rms(y=audio, frame_length=4_096, hop_length=hop_length)[0]
    if len(rms) < len(estimated):
        rms = np.pad(rms, (0, len(estimated) - len(rms)), mode="edge")
    silence = max(1e-5, float(np.percentile(rms, 10)) * 0.25)
    estimated = ["N" if rms[index] < silence else label for index, label in enumerate(estimated)]
    times = librosa.frames_to_time(
        np.arange(len(estimated)),
        sr=sample_rate,
        hop_length=hop_length,
    )
    return _segments_from_frames(times, estimated, duration)


def _boundary_f1(
    reference: np.ndarray,
    estimated: np.ndarray,
    tolerance: float = 0.5,
) -> tuple[float, float, float]:
    ref = reference[1:, 0]
    est = estimated[1:, 0]
    used: set[int] = set()
    matches = 0
    for boundary in est:
        candidates = [
            (abs(boundary - target), index)
            for index, target in enumerate(ref)
            if index not in used and abs(boundary - target) <= tolerance
        ]
        if not candidates:
            continue
        _, index = min(candidates)
        used.add(index)
        matches += 1
    precision = matches / len(est) if len(est) else float(not len(ref))
    recall = matches / len(ref) if len(ref) else float(not len(est))
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


def _coverage(intervals: np.ndarray, labels: list[str]) -> float:
    durations = intervals[:, 1] - intervals[:, 0]
    covered = 0.0
    for duration, label in zip(durations, labels, strict=True):
        base = label.split("/", 1)[0]
        if base in {"N", "X"}:
            covered += float(duration)
            continue
        quality = base.partition(":")[2] or "maj"
        if quality in SUPPORTED_QUALITIES:
            covered += float(duration)
    return covered / float(durations.sum())


def _distribution(values: list[float]) -> dict[str, float]:
    quartiles = statistics.quantiles(values, n=4, method="inclusive")
    return {
        "min": min(values),
        "q1": quartiles[0],
        "median": statistics.median(values),
        "mean": statistics.fmean(values),
        "q3": quartiles[2],
        "max": max(values),
    }


def _directory_size(path: Path) -> int:
    return sum(candidate.stat().st_size for candidate in path.rglob("*") if candidate.is_file())


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark ChordMini against librosa chroma")
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    jams_files = sorted(args.annotations.rglob("*_comp.jams"))
    if args.limit is not None:
        jams_files = jams_files[: args.limit]
    if not jams_files:
        raise SystemExit("No *_comp.jams annotations found")

    per_track: list[dict[str, object]] = []
    started = time.perf_counter()
    for number, jams_path in enumerate(jams_files, start=1):
        ref_intervals, ref_labels, duration = _reference(jams_path)
        audio_path = _find_audio(args.audio, jams_path.stem)
        sample_rate = sf.info(audio_path).samplerate
        tab = TabDocument(sample_rate=sample_rate)

        model_started = time.perf_counter()
        chord_track = recognize_chords(audio_path, 0, duration, tab)
        model_runtime = time.perf_counter() - model_started
        model_intervals, model_labels = _track_intervals(chord_track)

        baseline_started = time.perf_counter()
        baseline_intervals, baseline_labels = _librosa_baseline(audio_path, duration)
        baseline_runtime = time.perf_counter() - baseline_started

        engines: dict[str, object] = {}
        for engine, intervals, labels, runtime in (
            ("chordmini", model_intervals, model_labels, model_runtime),
            ("librosa", baseline_intervals, baseline_labels, baseline_runtime),
        ):
            scores = mir_eval.chord.evaluate(
                ref_intervals,
                ref_labels,
                intervals,
                labels,
            )
            precision, recall, f1 = _boundary_f1(ref_intervals, intervals)
            engines[engine] = {
                **{metric: float(scores[metric]) for metric in METRICS},
                "boundary_precision": precision,
                "boundary_recall": recall,
                "boundary_f1": f1,
                "segments": len(intervals),
                "runtime_s": runtime,
            }
        per_track.append(
            {
                "track": jams_path.stem,
                "duration_s": duration,
                "vocabulary_coverage": _coverage(ref_intervals, ref_labels),
                "engines": engines,
            }
        )
        elapsed = time.perf_counter() - started
        remaining = elapsed / number * (len(jams_files) - number)
        print(
            f"[{number:03d}/{len(jams_files):03d}] {jams_path.stem} "
            f"{model_runtime:.2f}s model, {baseline_runtime:.2f}s baseline, "
            f"ETA {remaining / 60:.1f}m",
            file=sys.stderr,
            flush=True,
        )

    aggregate: dict[str, object] = {}
    total_duration = sum(float(row["duration_s"]) for row in per_track)
    for engine in ("chordmini", "librosa"):
        engine_rows = [row["engines"][engine] for row in per_track]
        aggregate[engine] = {
            metric: sum(
                float(row["duration_s"]) * float(row["engines"][engine][metric])
                for row in per_track
            )
            / total_duration
            for metric in METRICS
        }
        aggregate[engine].update(
            {
                "boundary_precision": statistics.fmean(
                    float(row["boundary_precision"]) for row in engine_rows
                ),
                "boundary_recall": statistics.fmean(
                    float(row["boundary_recall"]) for row in engine_rows
                ),
                "boundary_f1": statistics.fmean(float(row["boundary_f1"]) for row in engine_rows),
                "runtime_s": sum(float(row["runtime_s"]) for row in engine_rows),
                "runtime_realtime_factor": sum(float(row["runtime_s"]) for row in engine_rows)
                / total_duration,
                "per_track_distribution": {
                    metric: _distribution([float(row[metric]) for row in engine_rows])
                    for metric in (*METRICS, "boundary_f1", "runtime_s")
                },
            }
        )

    import onnxruntime

    onnxruntime_size = _directory_size(Path(onnxruntime.__file__).resolve().parent)
    model_size = (
        (
            Path(__file__).resolve().parents[1]
            / "server"
            / "solotrace"
            / "resources"
            / "chordmini"
            / "chordnet.onnx"
        )
        .stat()
        .st_size
    )
    payload = {
        "dataset": {
            "name": "GuitarSet 1.1.0 mono-mic accompaniment performances",
            "doi": "10.5281/zenodo.3371780",
            "tracks": len(per_track),
            "duration_s": total_duration,
            "selection": "*_comp.jams (180 accompaniment performances; solo files excluded)",
            "reference": "performed chord annotation",
            "annotation_caveat": (
                "Chord sheet-informed labels use predetermined segmentation and "
                "separate-string note transcriptions with manual verification."
            ),
        },
        "model": {
            "revision": MODEL_REVISION,
            "sha256": MODEL_SHA256,
        },
        "aggregate": aggregate,
        "vocabulary_coverage": {
            "duration_weighted": sum(
                float(row["duration_s"]) * float(row["vocabulary_coverage"]) for row in per_track
            )
            / total_duration,
            "per_track_distribution": _distribution(
                [float(row["vocabulary_coverage"]) for row in per_track]
            ),
        },
        "package_size_delta": {
            "model_bytes": model_size,
            "onnxruntime_installed_bytes": onnxruntime_size,
            "raw_total_bytes": model_size + onnxruntime_size,
            "baseline_incremental_bytes": 0,
        },
        "wall_runtime_s": time.perf_counter() - started,
        "per_track": per_track,
    }
    if not math.isfinite(float(payload["wall_runtime_s"])):
        raise RuntimeError("Benchmark produced a non-finite runtime")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(json.dumps({key: payload[key] for key in ("dataset", "aggregate")}, indent=2))


if __name__ == "__main__":
    main()
