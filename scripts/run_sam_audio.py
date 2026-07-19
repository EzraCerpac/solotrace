from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from mlx_audio.sts import SAMAudio, save_audio


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run MLX SAM-Audio on one benchmark clip.")
    parser.add_argument("audio", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument(
        "--model",
        default="mlx-community/sam-audio-small-fp16",
    )
    parser.add_argument("--prompt", default="lead electric guitar")
    parser.add_argument(
        "--positive-span",
        nargs=2,
        type=float,
        metavar=("START_S", "END_S"),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    model = SAMAudio.from_pretrained(args.model)
    anchors = (
        [[("+", args.positive_span[0], args.positive_span[1])]]
        if args.positive_span
        else None
    )
    started = time.perf_counter()
    result = model.separate(
        audios=[str(args.audio)],
        descriptions=[args.prompt],
        anchors=anchors,
        ode_decode_chunk_size=50,
    )
    seconds = time.perf_counter() - started
    target = args.output_dir / "lead.wav"
    residual = args.output_dir / "residual.wav"
    save_audio(result.target[0], target, sample_rate=model.sample_rate)
    save_audio(result.residual[0], residual, sample_rate=model.sample_rate)
    metadata = {
        "model": args.model,
        "prompt": args.prompt,
        "positive_span": args.positive_span,
        "seconds": seconds,
        "peak_memory_gb": float(result.peak_memory),
        "sample_rate": model.sample_rate,
        "lead": str(target.resolve()),
        "residual": str(residual.resolve()),
    }
    (args.output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
