from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment
from scipy.signal import correlate, correlation_lags, resample_poly

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = ROOT / ".benchmarks" / "lead-separation"
SOURCE_ROOT = ROOT / ".benchmarks" / "model-benchmark" / "audio"
EGSET_ROOT = ROOT / ".benchmarks" / "egset12"
LEAD_TRACKS = ("01", "02", "07", "12")
RHYTHM_TRACK = "06"
ONSET_TOLERANCE_S = 0.05
MAX_ALIGNMENT_S = 0.25


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare and score the controlled lead-versus-rhythm benchmark."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--output-dir", type=Path, default=DEFAULT_ROOT)

    score = subparsers.add_parser("score")
    score.add_argument(
        "--routes",
        type=Path,
        default=DEFAULT_ROOT / "routes.json",
        help="JSON route manifest containing lead and optional residual estimates.",
    )
    score.add_argument(
        "--benchmark",
        type=Path,
        default=DEFAULT_ROOT / "benchmark.json",
    )
    score.add_argument("--output", type=Path, default=DEFAULT_ROOT / "results.json")
    return parser.parse_args()


def _load(path: Path, sample_rate: int | None = None) -> tuple[np.ndarray, int]:
    audio, original_rate = sf.read(path, always_2d=True, dtype="float32")
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    elif audio.shape[1] > 2:
        audio = audio[:, :2]
    if sample_rate is None or sample_rate == original_rate:
        return audio, original_rate
    divisor = math.gcd(sample_rate, original_rate)
    audio = resample_poly(audio, sample_rate // divisor, original_rate // divisor, axis=0)
    return audio.astype(np.float32), sample_rate


def _repeat_to_fit(audio: np.ndarray, frames: int) -> np.ndarray:
    if len(audio) >= frames:
        return audio[:frames]
    repeats = math.ceil(frames / len(audio))
    return np.tile(audio, (repeats, 1))[:frames]


def _pad_to_fit(audio: np.ndarray, frames: int) -> np.ndarray:
    if len(audio) >= frames:
        return audio[:frames]
    return np.pad(audio, ((0, frames - len(audio)), (0, 0)))


def _rms(audio: np.ndarray) -> float:
    return math.sqrt(float(np.mean(np.square(audio, dtype=np.float64))) + 1e-12)


def _write(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio, sample_rate, subtype="FLOAT")


def load_truth(track: str) -> list[dict[str, Any]]:
    payload = json.loads((EGSET_ROOT / f"{track}.jams").read_text())
    notes: list[dict[str, Any]] = []
    for annotation in payload["annotations"]:
        if annotation["namespace"] != "note_midi":
            continue
        for event in annotation["data"]:
            notes.append(
                {
                    "onset": float(event["time"]),
                    "offset": float(event["time"] + event["duration"]),
                    "pitch": int(event["value"]),
                }
            )
    return sorted(notes, key=lambda note: (note["onset"], note["pitch"]))


def prepare(output_dir: Path) -> None:
    rhythm_source, rhythm_rate = _load(EGSET_ROOT / f"{RHYTHM_TRACK}.wav")
    cases: dict[str, Any] = {}
    for index, track in enumerate(LEAD_TRACKS):
        case_name = f"duet-{track}"
        source_dir = SOURCE_ROOT / track
        lead, sample_rate = _load(source_dir / "lead-reference.wav")
        backing, _ = _load(source_dir / "backing.wav", sample_rate)
        backing = _repeat_to_fit(backing, len(lead))
        rhythm = rhythm_source
        if rhythm_rate != sample_rate:
            divisor = math.gcd(sample_rate, rhythm_rate)
            rhythm = resample_poly(
                rhythm,
                sample_rate // divisor,
                rhythm_rate // divisor,
                axis=0,
            ).astype(np.float32)
        offset = round(index * 0.41 * sample_rate)
        rhythm = _repeat_to_fit(np.roll(rhythm, -offset, axis=0), len(lead))
        rhythm *= 0.72 * _rms(lead) / _rms(rhythm)

        mixture = lead + rhythm + backing
        scale = min(1.0, 0.97 / (float(np.max(np.abs(mixture))) + 1e-12))
        lead *= scale
        rhythm *= scale
        backing *= scale
        mixture *= scale
        residual = rhythm + backing

        case_dir = output_dir / "audio" / case_name
        paths = {
            "mixture": case_dir / f"{case_name}.wav",
            "lead": case_dir / "lead.wav",
            "rhythm": case_dir / "rhythm.wav",
            "other": case_dir / "other.wav",
            "residual": case_dir / "residual.wav",
        }
        for role, audio in (
            ("mixture", mixture),
            ("lead", lead),
            ("rhythm", rhythm),
            ("other", backing),
            ("residual", residual),
        ):
            _write(paths[role], audio, sample_rate)
        cases[case_name] = {
            "lead_track": track,
            "rhythm_track": RHYTHM_TRACK,
            "sample_rate": sample_rate,
            "duration_s": len(lead) / sample_rate,
            "paths": {role: str(path.resolve()) for role, path in paths.items()},
        }

    output_dir.mkdir(parents=True, exist_ok=True)
    benchmark = {
        "name": "EGSet12 controlled lead/rhythm stress test",
        "dataset": "EGSet12",
        "dataset_license": "CC BY 4.0",
        "lead_definition": "Selected EGSet12 foreground guitar performance",
        "rhythm_definition": "Independent polyphonic EGSet12 track 06 at 0.72x lead RMS",
        "limitation": (
            "Controlled role labels, not real multitrack production stems; use to expose "
            "all-guitar models that leak simultaneous rhythm into the lead output."
        ),
        "cases": cases,
    }
    path = output_dir / "benchmark.json"
    path.write_text(json.dumps(benchmark, indent=2) + "\n")
    print(f"Wrote {path}")


def align(reference: np.ndarray, estimate: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
    reference_mono = np.mean(reference, axis=1)
    estimate_mono = np.mean(estimate, axis=1)
    envelope_rate = 400
    hop = max(1, sample_rate // envelope_rate)
    reference_envelope = np.abs(reference_mono[::hop])
    estimate_envelope = np.abs(estimate_mono[::hop])
    max_lag = round(MAX_ALIGNMENT_S * sample_rate / hop)
    values = correlate(estimate_envelope, reference_envelope, mode="full", method="fft")
    lags = correlation_lags(len(estimate_envelope), len(reference_envelope), mode="full")
    allowed = np.abs(lags) <= max_lag
    lag = int(lags[allowed][np.argmax(values[allowed])]) * hop
    if lag > 0:
        estimate = estimate[lag:]
    elif lag < 0:
        estimate = np.pad(estimate, ((-lag, 0), (0, 0)))
    return _pad_to_fit(estimate, len(reference)), lag


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    reference = reference.reshape(-1).astype(np.float64)
    estimate = estimate.reshape(-1).astype(np.float64)
    reference -= np.mean(reference)
    estimate -= np.mean(estimate)
    projection = np.dot(estimate, reference) / (np.dot(reference, reference) + 1e-12)
    target = projection * reference
    noise = estimate - target
    return 10 * math.log10(
        (float(np.dot(target, target)) + 1e-12)
        / (float(np.dot(noise, noise)) + 1e-12)
    )


def projection_shares(
    estimate: np.ndarray,
    lead: np.ndarray,
    rhythm: np.ndarray,
    other: np.ndarray,
) -> dict[str, float]:
    sources = np.column_stack(
        [
            lead.reshape(-1).astype(np.float64),
            rhythm.reshape(-1).astype(np.float64),
            other.reshape(-1).astype(np.float64),
        ]
    )
    target = estimate.reshape(-1).astype(np.float64)
    coefficients, *_ = np.linalg.lstsq(sources, target, rcond=None)
    energies = np.square(coefficients) * np.sum(np.square(sources), axis=0)
    total = float(np.sum(energies)) + 1e-12
    return {
        role: float(energy / total)
        for role, energy in zip(("lead", "rhythm", "other"), energies, strict=True)
    }


def match_notes(
    reference: list[dict[str, Any]],
    estimated: list[dict[str, Any]],
) -> int:
    if not reference or not estimated:
        return 0
    blocked = 1_000.0
    unmatched = 1.1
    cost = np.full(
        (len(reference) + len(estimated), len(estimated) + len(reference)),
        blocked,
    )
    for ref_index, ref_note in enumerate(reference):
        for est_index, est_note in enumerate(estimated):
            onset_error = abs(ref_note["onset"] - est_note["onset"])
            if ref_note["pitch"] == est_note["pitch"] and onset_error <= ONSET_TOLERANCE_S:
                cost[ref_index, est_index] = onset_error / ONSET_TOLERANCE_S
        cost[ref_index, len(estimated) + ref_index] = unmatched
    for est_index in range(len(estimated)):
        cost[len(reference) + est_index, est_index] = unmatched
    cost[len(reference) :, len(estimated) :] = 0
    rows, columns = linear_sum_assignment(cost)
    return int(
        sum(
            row < len(reference)
            and column < len(estimated)
            and cost[row, column] <= 1
            for row, column in zip(rows, columns, strict=True)
        )
    )


def shift_notes(notes: list[dict[str, Any]], seconds: float) -> list[dict[str, Any]]:
    return [
        {
            **note,
            "onset": note["onset"] + seconds,
            "offset": note["offset"] + seconds,
        }
        for note in notes
    ]


def transcribe(
    estimates: dict[str, Path],
    output_dir: Path,
) -> dict[str, dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "transcription-manifest.json"
    predictions_path = output_dir / "basic-pitch.json"
    manifest = {key: str(path.resolve()) for key, path in estimates.items()}
    if (
        predictions_path.exists()
        and manifest_path.exists()
        and json.loads(manifest_path.read_text()) == manifest
    ):
        return json.loads(predictions_path.read_text())
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run(
        [
            str(ROOT / ".workers" / "transcribe" / "bin" / "python"),
            str(ROOT / "scripts" / "benchmark" / "basic_pitch_worker.py"),
            "--manifest",
            str(manifest_path),
            "--output",
            str(predictions_path),
        ],
        cwd=ROOT,
        check=True,
    )
    return json.loads(predictions_path.read_text())


def score(routes_path: Path, benchmark_path: Path, output: Path) -> None:
    routes = json.loads(routes_path.read_text())
    benchmark = json.loads(benchmark_path.read_text())
    estimate_paths = {
        f"{route_name}:{case_name}": Path(case["lead"])
        for route_name, route in routes["routes"].items()
        for case_name, case in route["cases"].items()
    }
    predictions = transcribe(estimate_paths, output.parent / "transcription")
    result_routes: list[dict[str, Any]] = []
    for route_name, route in routes["routes"].items():
        route_started = time.perf_counter()
        rows = []
        reference_total = estimated_total = matched_total = 0
        for case_name, case_estimates in route["cases"].items():
            case = benchmark["cases"][case_name]
            lead, sample_rate = _load(Path(case["paths"]["lead"]))
            rhythm, _ = _load(Path(case["paths"]["rhythm"]), sample_rate)
            other, _ = _load(Path(case["paths"]["other"]), sample_rate)
            residual, _ = _load(Path(case["paths"]["residual"]), sample_rate)
            mixture, _ = _load(Path(case["paths"]["mixture"]), sample_rate)
            estimate, _ = _load(Path(case_estimates["lead"]), sample_rate)
            estimate, lag = align(lead, estimate, sample_rate)
            prediction = shift_notes(
                predictions[f"{route_name}:{case_name}"]["notes"],
                -lag / sample_rate,
            )
            reference_notes = load_truth(case["lead_track"])
            matched = match_notes(reference_notes, prediction)
            reference_total += len(reference_notes)
            estimated_total += len(prediction)
            matched_total += matched
            row: dict[str, Any] = {
                "case": case_name,
                "lead_si_sdr": si_sdr(lead, estimate),
                "lag_samples": lag,
                "projection_shares": projection_shares(estimate, lead, rhythm, other),
                "reference_notes": len(reference_notes),
                "estimated_notes": len(prediction),
                "matched_notes": matched,
            }
            if case_estimates.get("residual"):
                residual_estimate, _ = _load(Path(case_estimates["residual"]), sample_rate)
                residual_estimate, _ = align(residual, residual_estimate, sample_rate)
                row["residual_method"] = "native"
            else:
                residual_estimate = mixture - estimate
                row["residual_method"] = "mixture-minus-estimate"
            row["residual_si_sdr"] = si_sdr(residual, residual_estimate)
            reconstruction = estimate + residual_estimate
            row["mixture_consistency_db"] = si_sdr(mixture, reconstruction)
            rows.append(row)
        precision = matched_total / estimated_total if estimated_total else 0
        recall = matched_total / reference_total if reference_total else 0
        note_f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
        result_routes.append(
            {
                "route": route_name,
                "scope": route["scope"],
                "status": route.get("status", "ran"),
                "cases": rows,
                "median_lead_si_sdr": float(np.median([row["lead_si_sdr"] for row in rows])),
                "median_residual_si_sdr": float(
                    np.median([row["residual_si_sdr"] for row in rows])
                ),
                "mean_rhythm_leakage": float(
                    np.mean([row["projection_shares"]["rhythm"] for row in rows])
                ),
                "note_precision": precision,
                "note_recall": recall,
                "note_f1": note_f1,
                "reported_separator_seconds": route.get("seconds"),
                "scoring_seconds": time.perf_counter() - route_started,
                "notes": route.get("notes"),
            }
        )
    result = {
        "benchmark": benchmark["name"],
        "limitation": benchmark["limitation"],
        "onset_tolerance_s": ONSET_TOLERANCE_S,
        "routes": result_routes,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Wrote {output}")


def main() -> None:
    args = parse_args()
    if args.command == "prepare":
        prepare(args.output_dir)
    else:
        score(args.routes, args.benchmark, args.output)


if __name__ == "__main__":
    main()
