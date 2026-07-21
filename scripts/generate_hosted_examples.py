from __future__ import annotations

import argparse
from pathlib import Path

from solotrace.demo import write_hosted_examples


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate SoloTrace's static hosted examples")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("site/public/examples"),
        help="directory for catalog, projects, peaks, and WAV stems",
    )
    args = parser.parse_args()
    catalog = write_hosted_examples(args.output)
    print(f"Generated {len(catalog)} examples in {args.output}")


if __name__ == "__main__":
    main()
