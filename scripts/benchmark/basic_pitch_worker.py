from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
import time
from pathlib import Path

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest: dict[str, str] = json.loads(args.manifest.read_text())
    model = Model(ICASSP_2022_MODEL_PATH)
    results: dict[str, object] = {}
    total = len(manifest)
    for index, (key, audio_path) in enumerate(manifest.items(), start=1):
        started = time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):
            _, _, events = predict(
                audio_path,
                model,
                minimum_frequency=80,
                maximum_frequency=1400,
                multiple_pitch_bends=True,
            )
        results[key] = {
            "seconds": time.perf_counter() - started,
            "notes": [
                {
                    "onset": float(onset),
                    "offset": float(offset),
                    "pitch": int(pitch),
                    "confidence": float(confidence),
                    "bends": [int(value) for value in bends] if bends else [],
                }
                for onset, offset, pitch, confidence, bends in events
            ],
        }
        print(f"Basic Pitch {index}/{total}: {key}", file=sys.stderr, flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
