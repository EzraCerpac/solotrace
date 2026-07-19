from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from solotrace.audio import (  # noqa: E402
    AudioProcessingError,
    create_preview_stems,
    transcribe_pyin,
)

TUNING = [40, 45, 50, 55, 59, 64]
CONDITIONS = ("clean", "mix", "preview", "demucs")
TRANSCRIBERS = ("pyin", "basic-pitch", "tabcnn")
ONSET_TOLERANCE_S = 0.05


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark SoloTrace model routes against EGSet12 ground truth."
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=ROOT / ".benchmarks" / "egset12",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=ROOT / ".benchmarks" / "model-benchmark",
    )
    parser.add_argument("--limit", type=int, default=12)
    return parser.parse_args()


def load_ground_truth(path: Path) -> tuple[list[dict[str, Any]], float, float]:
    payload = json.loads(path.read_text())
    notes: list[dict[str, Any]] = []
    tempo = 120.0
    for annotation in payload["annotations"]:
        if annotation["namespace"] == "tempo":
            tempo = float(annotation["data"][0]["value"])
        if annotation["namespace"] != "note_midi":
            continue
        string_index = int(annotation["annotation_metadata"]["data_source"])
        for event in annotation["data"]:
            pitch = int(event["value"])
            notes.append(
                {
                    "onset": float(event["time"]),
                    "offset": float(event["time"] + event["duration"]),
                    "pitch": pitch,
                    "string_index": string_index,
                    "fret": pitch - TUNING[string_index],
                }
            )
    notes.sort(key=lambda note: (note["onset"], note["pitch"]))
    return notes, float(payload["file_metadata"]["duration"]), tempo


def _tone(
    output: np.ndarray,
    sample_rate: int,
    start_s: float,
    duration_s: float,
    frequency: float,
    gain: float,
    harmonics: int = 1,
) -> None:
    start = max(0, round(start_s * sample_rate))
    end = min(len(output), round((start_s + duration_s) * sample_rate))
    if end <= start:
        return
    time_axis = np.arange(end - start, dtype=np.float32) / sample_rate
    envelope = np.minimum(1, time_axis / 0.012) * np.exp(-time_axis / max(0.08, duration_s))
    signal = np.zeros_like(time_axis)
    for harmonic in range(1, harmonics + 1):
        signal += np.sin(2 * np.pi * frequency * harmonic * time_axis) / harmonic
    output[start:end] += gain * envelope * signal


def synthesize_backing(
    lead_path: Path,
    ground_truth: list[dict[str, Any]],
    tempo: float,
    output_dir: Path,
) -> dict[str, Path]:
    lead, sample_rate = librosa.load(lead_path, sr=None, mono=True)
    duration_s = len(lead) / sample_rate
    backing = np.zeros_like(lead, dtype=np.float32)
    pitch_class = Counter(note["pitch"] % 12 for note in ground_truth).most_common(1)[0][0]
    bass_root = 36 + pitch_class
    beat_s = 60 / tempo
    rng = np.random.default_rng(int(lead_path.stem))

    beat = 0
    while beat * beat_s < duration_s:
        beat_start = beat * beat_s
        bass_pitch = bass_root + (7 if beat % 4 in {1, 3} else 0)
        _tone(
            backing,
            sample_rate,
            beat_start,
            beat_s * 0.82,
            float(librosa.midi_to_hz(bass_pitch)),
            0.34,
            harmonics=3,
        )
        _tone(backing, sample_rate, beat_start, 0.22, 54, 0.5, harmonics=2)
        if beat % 4 in {1, 3}:
            start = min(len(backing), round(beat_start * sample_rate))
            end = min(len(backing), start + round(0.18 * sample_rate))
            if end > start:
                noise = rng.standard_normal(end - start).astype(np.float32)
                envelope = np.exp(-np.arange(end - start) / (sample_rate * 0.045))
                backing[start:end] += 0.16 * noise * envelope
        for half in (0.0, 0.5):
            start_s = beat_start + half * beat_s
            start = min(len(backing), round(start_s * sample_rate))
            end = min(len(backing), start + round(0.045 * sample_rate))
            if end > start:
                noise = rng.standard_normal(end - start).astype(np.float32)
                envelope = np.exp(-np.arange(end - start) / (sample_rate * 0.012))
                backing[start:end] += 0.045 * noise * envelope
        beat += 1

    for measure_start in np.arange(0, duration_s, beat_s * 4):
        for semitones in (12, 16, 19):
            _tone(
                backing,
                sample_rate,
                float(measure_start),
                min(beat_s * 3.8, duration_s - measure_start),
                float(librosa.midi_to_hz(bass_root + semitones)),
                0.035,
                harmonics=2,
            )

    lead_rms = math.sqrt(float(np.mean(lead**2)) + 1e-12)
    backing_rms = math.sqrt(float(np.mean(backing**2)) + 1e-12)
    backing *= lead_rms * 0.9 / backing_rms
    mixture = lead + backing
    scale = min(1.0, 0.97 / max(1e-6, float(np.max(np.abs(mixture)))))
    lead_reference = lead * scale
    backing *= scale
    mixture *= scale
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "clean": lead_path,
        "reference": output_dir / "lead-reference.wav",
        "backing": output_dir / "backing.wav",
        "mix": output_dir / "mix.wav",
    }
    for role in ("reference", "backing", "mix"):
        audio = {
            "reference": lead_reference,
            "backing": backing,
            "mix": mixture,
        }[role]
        sf.write(paths[role], np.column_stack([audio, audio]), sample_rate, subtype="PCM_16")
    return paths


def prepare_audio_unique(
    tracks: list[str],
    data_dir: Path,
    work_dir: Path,
    truth: dict[str, list[dict[str, Any]]],
    durations: dict[str, float],
    tempos: dict[str, float],
) -> tuple[dict[str, dict[str, Path]], dict[str, float]]:
    routes: dict[str, dict[str, Path]] = {condition: {} for condition in CONDITIONS}
    separation_time = {"preview": 0.0, "demucs": 0.0}
    for index, track in enumerate(tracks, start=1):
        track_dir = work_dir / "audio" / track
        mixed = synthesize_backing(
            data_dir / f"{track}.wav",
            truth[track],
            tempos[track],
            track_dir,
        )
        unique_mix = track_dir / f"{track}-mix.wav"
        mixed["mix"].replace(unique_mix)
        mixed["mix"] = unique_mix
        routes["clean"][track] = mixed["clean"]
        routes["mix"][track] = mixed["mix"]
        preview_dir = work_dir / "preview" / track
        preview_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        create_preview_stems(
            mixed["mix"],
            preview_dir / "guitar.wav",
            preview_dir / "backing.wav",
            0,
            durations[track],
        )
        separation_time["preview"] += time.perf_counter() - started
        routes["preview"][track] = preview_dir / "guitar.wav"
        print(f"Prepared controlled mix {index}/{len(tracks)}: {track}", flush=True)

    demucs_output = work_dir / "demucs"
    command = [
        str(ROOT / ".workers" / "separate" / "bin" / "demucs-mlx"),
        "-n",
        "htdemucs_6s",
        "-o",
        str(demucs_output),
        "--shifts",
        "0",
        "--overlap",
        "0.25",
        "--batch-size",
        "1",
        "--write-workers",
        "1",
        "--prefetch-tracks",
        "0",
        *(str(routes["mix"][track]) for track in tracks),
    ]
    started = time.perf_counter()
    subprocess.run(command, cwd=ROOT, check=True)
    separation_time["demucs"] = time.perf_counter() - started
    for track in tracks:
        routes["demucs"][track] = demucs_output / f"{track}-mix" / "guitar.wav"
    return routes, separation_time


def product_fingering(pitch: int, previous: tuple[int, int] | None) -> tuple[int, int]:
    choices = [
        (string_index, pitch - open_pitch)
        for string_index, open_pitch in enumerate(TUNING)
        if 0 <= pitch - open_pitch <= 22
    ]
    if not choices:
        return -1, -1
    if previous is None:
        return min(choices, key=lambda choice: (choice[1], -choice[0]))
    return min(
        choices,
        key=lambda choice: (
            abs(choice[1] - previous[1]) + 0.36 * abs(choice[0] - previous[0]),
            choice[1],
        ),
    )


def add_symbolic_fingering(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    previous = None
    output = []
    for note in sorted(notes, key=lambda item: (item["onset"], item["pitch"])):
        string_index, fret = product_fingering(note["pitch"], previous)
        if string_index < 0:
            continue
        current = dict(note, string_index=string_index, fret=fret)
        output.append(current)
        previous = (string_index, fret)
    return output


def run_pyin(
    routes: dict[str, dict[str, Path]],
    tracks: list[str],
    durations: dict[str, float],
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    total = len(CONDITIONS) * len(tracks)
    index = 0
    for condition in CONDITIONS:
        for track in tracks:
            index += 1
            key = f"{condition}:{track}"
            started = time.perf_counter()
            try:
                document = transcribe_pyin(
                    routes[condition][track],
                    0,
                    durations[track],
                    TUNING,
                    22,
                    rhythm_path=routes["mix"][track],
                )
                notes = [
                    {
                        "onset": note.audio_onset_s,
                        "offset": note.audio_offset_s,
                        "pitch": note.midi_pitch,
                        "string_index": 6 - note.string,
                        "fret": note.fret,
                    }
                    for note in document.notes
                ]
            except AudioProcessingError:
                notes = []
            output[key] = {
                "seconds": time.perf_counter() - started,
                "notes": notes,
            }
            print(f"pYIN {index}/{total}: {key}", flush=True)
    return output


def route_manifest(
    routes: dict[str, dict[str, Path]],
    tracks: list[str],
    output: Path,
) -> Path:
    manifest = {
        f"{condition}:{track}": str(routes[condition][track].resolve())
        for condition in CONDITIONS
        for track in tracks
    }
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    return output


def run_worker(
    python: Path,
    script: Path,
    manifest: Path,
    output: Path,
    *extra: str,
) -> dict[str, dict[str, Any]]:
    subprocess.run(
        [
            str(python),
            str(script),
            "--manifest",
            str(manifest),
            "--output",
            str(output),
            *extra,
        ],
        cwd=ROOT,
        check=True,
    )
    return json.loads(output.read_text())


def match_notes(
    reference: list[dict[str, Any]],
    estimated: list[dict[str, Any]],
) -> list[tuple[int, int]]:
    ref_count = len(reference)
    est_count = len(estimated)
    if not ref_count or not est_count:
        return []
    unmatched = 1.1
    blocked = 1_000.0
    cost = np.full((ref_count + est_count, est_count + ref_count), blocked)
    for ref_index, ref_note in enumerate(reference):
        for est_index, est_note in enumerate(estimated):
            difference = abs(ref_note["onset"] - est_note["onset"])
            if ref_note["pitch"] == est_note["pitch"] and difference <= ONSET_TOLERANCE_S:
                cost[ref_index, est_index] = difference / ONSET_TOLERANCE_S
        cost[ref_index, est_count + ref_index] = unmatched
    for est_index in range(est_count):
        cost[ref_count + est_index, est_index] = unmatched
    cost[ref_count:, est_count:] = 0
    rows, columns = linear_sum_assignment(cost)
    return [
        (int(row), int(column))
        for row, column in zip(rows, columns, strict=True)
        if row < ref_count and column < est_count and cost[row, column] <= 1
    ]


def score_track(
    reference: list[dict[str, Any]],
    estimated: list[dict[str, Any]],
) -> dict[str, Any]:
    matches = match_notes(reference, estimated)
    exact_positions = sum(
        reference[ref_index]["string_index"] == estimated[est_index].get("string_index")
        and reference[ref_index]["fret"] == estimated[est_index].get("fret")
        for ref_index, est_index in matches
    )
    onset_errors = [
        abs(reference[ref_index]["onset"] - estimated[est_index]["onset"]) * 1000
        for ref_index, est_index in matches
    ]
    return {
        "reference": len(reference),
        "estimated": len(estimated),
        "matched": len(matches),
        "position_matched": exact_positions,
        "onset_errors_ms": onset_errors,
    }


def aggregate(
    route: str,
    tracks: list[str],
    scored: dict[str, dict[str, Any]],
    predictions: dict[str, dict[str, Any]],
    separation_seconds: float,
) -> dict[str, Any]:
    reference = sum(scored[track]["reference"] for track in tracks)
    estimated = sum(scored[track]["estimated"] for track in tracks)
    matched = sum(scored[track]["matched"] for track in tracks)
    position_matched = sum(scored[track]["position_matched"] for track in tracks)
    precision = matched / estimated if estimated else 0
    recall = matched / reference if reference else 0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
    tab_precision = position_matched / estimated if estimated else 0
    tab_recall = position_matched / reference if reference else 0
    tab_f1 = (
        2 * tab_precision * tab_recall / (tab_precision + tab_recall)
        if tab_precision + tab_recall
        else 0
    )
    errors = [
        value
        for track in tracks
        for value in scored[track]["onset_errors_ms"]
    ]
    processing = sum(predictions[f"{route}:{track}"]["seconds"] for track in tracks)
    return {
        "route": route,
        "note_precision": precision,
        "note_recall": recall,
        "note_f1": f1,
        "tab_f1": tab_f1,
        "tdr": position_matched / matched if matched else 0,
        "median_onset_error_ms": float(np.median(errors)) if errors else None,
        "seconds_per_track": (processing + separation_seconds) / len(tracks),
        "reference_notes": reference,
        "estimated_notes": estimated,
        "matched_notes": matched,
    }


def si_sdr(reference_path: Path, estimate_path: Path) -> float:
    reference, sample_rate = librosa.load(reference_path, sr=None, mono=True)
    estimate, _ = librosa.load(estimate_path, sr=sample_rate, mono=True)
    length = min(len(reference), len(estimate))
    reference = reference[:length] - np.mean(reference[:length])
    estimate = estimate[:length] - np.mean(estimate[:length])
    projection = np.dot(estimate, reference) / (np.dot(reference, reference) + 1e-12)
    target = projection * reference
    noise = estimate - target
    return 10 * math.log10(
        (float(np.dot(target, target)) + 1e-12)
        / (float(np.dot(noise, noise)) + 1e-12)
    )


def write_report(
    output: Path,
    summary: list[dict[str, Any]],
    separation: dict[str, Any],
    track_count: int,
) -> None:
    ranked = sorted(summary, key=lambda row: row["note_f1"], reverse=True)
    mixed = [row for row in ranked if not row["route"].startswith("clean-")]
    best = mixed[0]
    lines = [
        "# Enhanced model benchmark",
        "",
        f"Evaluated {track_count} EGSet12 electric-guitar performances against exact "
        "per-string JAMS/Guitar Pro ground truth. Note matches require exact MIDI pitch "
        "and onset within 50 ms.",
        "",
        "## Results",
        "",
        "| Route | Note F1 | Tab F1 | TDR | Median onset | Seconds/track |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in ranked:
        onset = (
            f"{row['median_onset_error_ms']:.1f} ms"
            if row["median_onset_error_ms"] is not None
            else "—"
        )
        lines.append(
            f"| {row['route']} | {row['note_f1']:.3f} | {row['tab_f1']:.3f} | "
            f"{row['tdr']:.3f} | {onset} | {row['seconds_per_track']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## Separation",
            "",
            "| Separator | Median SI-SDR | Mean SI-SDR |",
            "| --- | ---: | ---: |",
            f"| preview | {separation['preview']['median_si_sdr']:.2f} dB | "
            f"{separation['preview']['mean_si_sdr']:.2f} dB |",
            f"| Demucs htdemucs_6s | {separation['demucs']['median_si_sdr']:.2f} dB | "
            f"{separation['demucs']['mean_si_sdr']:.2f} dB |",
            "",
            "## Decision",
            "",
            f"Best controlled-mixture route: **{best['route']}** "
            f"(note F1 {best['note_f1']:.3f}, tab F1 {best['tab_f1']:.3f}).",
            "",
            "Tab F1 uses SoloTrace's deterministic fingering for pYIN and Basic Pitch; "
            "TabCNN predicts string/fret directly. EGSet12 is isolated guitar, so separation "
            "scores use a deterministic full-band backing mixed at 0.9× lead RMS.",
            "",
            "Dataset: [EGSet12, CC BY 4.0](https://zenodo.org/records/11406378).",
            "",
            "## Reproduce",
            "",
            "After `./scripts/install-enhanced-models.sh`, download EGSet12 and the "
            "authors' CC0 inference code:",
            "",
            "```bash",
            "mkdir -p .benchmarks",
            "curl -L https://zenodo.org/api/records/11406378/files-archive \\",
            "  -o .benchmarks/egset12.zip",
            "unzip .benchmarks/egset12.zip -d .benchmarks/egset12",
            "git clone https://github.com/robust-guitar-tabs/code \\",
            "  .benchmarks/robust-guitar-tabs-code",
            "uv pip install --python .workers/separate/bin/python -e \\",
            "  .benchmarks/robust-guitar-tabs-code/AMT-Tools",
            "```",
            "",
            "Then run:",
            "",
            "```bash",
            "env UV_CACHE_DIR=.uv-cache \\",
            "  MPLCONFIGDIR=.benchmarks/matplotlib-cache \\",
            "  PYTHONPATH=.benchmarks/robust-guitar-tabs-code/AMT-Tools \\",
            "  uv run python scripts/benchmark_models.py --limit 12",
            "```",
        ]
    )
    output.write_text("\n".join(lines) + "\n")


def main() -> None:
    args = parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    tracks = [
        path.stem
        for path in sorted(args.data_dir.glob("*.jams"))
        if path.stem.isdigit()
    ][: args.limit]
    if not tracks:
        raise SystemExit(f"No EGSet12 JAMS files found in {args.data_dir}")
    truth: dict[str, list[dict[str, Any]]] = {}
    durations: dict[str, float] = {}
    tempos: dict[str, float] = {}
    for track in tracks:
        truth[track], durations[track], tempos[track] = load_ground_truth(
            args.data_dir / f"{track}.jams"
        )

    routes, separation_time = prepare_audio_unique(
        tracks,
        args.data_dir,
        args.work_dir,
        truth,
        durations,
        tempos,
    )
    manifest = route_manifest(routes, tracks, args.work_dir / "manifest.json")
    pyin = run_pyin(routes, tracks, durations)
    basic_pitch = run_worker(
        ROOT / ".workers" / "transcribe" / "bin" / "python",
        ROOT / "scripts" / "benchmark" / "basic_pitch_worker.py",
        manifest,
        args.work_dir / "basic-pitch.json",
    )
    tabcnn = run_worker(
        ROOT / ".workers" / "separate" / "bin" / "python",
        ROOT / "scripts" / "benchmark" / "tabcnn_worker.py",
        manifest,
        args.work_dir / "tabcnn.json",
        "--checkpoint",
        str(args.data_dir / "best_TabCNN_tablature_trancription_model"),
    )
    all_predictions = {
        "pyin": pyin,
        "basic-pitch": {
            key: dict(value, notes=add_symbolic_fingering(value["notes"]))
            for key, value in basic_pitch.items()
        },
        "tabcnn": tabcnn,
    }

    summary = []
    per_track: dict[str, Any] = {}
    for condition in CONDITIONS:
        for transcriber in TRANSCRIBERS:
            route_name = f"{condition}-{transcriber}"
            predictions = all_predictions[transcriber]
            scored = {
                track: score_track(
                    truth[track],
                    predictions[f"{condition}:{track}"]["notes"],
                )
                for track in tracks
            }
            separation_seconds = separation_time.get(condition, 0)
            summary.append(
                aggregate(
                    condition,
                    tracks,
                    scored,
                    predictions,
                    separation_seconds,
                )
                | {"route": route_name}
            )
            per_track[route_name] = scored

    separation: dict[str, Any] = {}
    for condition in ("preview", "demucs"):
        values = [
            si_sdr(
                args.work_dir / "audio" / track / "lead-reference.wav",
                routes[condition][track],
            )
            for track in tracks
        ]
        separation[condition] = {
            "values": values,
            "median_si_sdr": float(np.median(values)),
            "mean_si_sdr": float(np.mean(values)),
            "seconds_total": separation_time[condition],
        }
    result = {
        "dataset": "EGSet12",
        "license": "CC BY 4.0",
        "tracks": tracks,
        "onset_tolerance_s": ONSET_TOLERANCE_S,
        "summary": summary,
        "separation": separation,
        "per_track": per_track,
    }
    results_path = args.work_dir / "results.json"
    results_path.write_text(json.dumps(result, indent=2) + "\n")
    write_report(
        ROOT / "docs" / "model-benchmark-results.md",
        summary,
        separation,
        len(tracks),
    )
    print(f"Wrote {results_path}")
    print(f"Wrote {ROOT / 'docs' / 'model-benchmark-results.md'}")


if __name__ == "__main__":
    main()
