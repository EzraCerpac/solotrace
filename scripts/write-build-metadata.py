from __future__ import annotations

import argparse
import json
import tomllib
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pyproject", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("build_id")
    args = parser.parse_args()
    project = tomllib.loads(args.pyproject.read_text())
    payload = {
        "appVersion": project["project"]["version"],
        "buildId": args.build_id,
    }
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
