from __future__ import annotations

import argparse
import json
from pathlib import Path

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--minimum-frequency", type=float, required=True)
    parser.add_argument("--maximum-frequency", type=float, required=True)
    args = parser.parse_args()

    model = Model(ICASSP_2022_MODEL_PATH)
    _, _, events = predict(
        args.audio,
        model,
        minimum_frequency=args.minimum_frequency,
        maximum_frequency=args.maximum_frequency,
        multiple_pitch_bends=True,
    )
    payload = [
        {
            "onset": float(onset),
            "offset": float(offset),
            "pitch": int(pitch),
            "confidence": float(confidence),
            "bends": [int(value) for value in bends] if bends else [],
        }
        for onset, offset, pitch, confidence, bends in events
    ]
    args.output.write_text(json.dumps(payload))


if __name__ == "__main__":
    main()
