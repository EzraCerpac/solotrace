from __future__ import annotations

import argparse
import importlib.metadata
import re
import shutil
from pathlib import Path


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "package"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    destination = args.destination
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    manifest: list[str] = []
    for distribution in sorted(
        importlib.metadata.distributions(),
        key=lambda item: (item.metadata.get("Name") or "").casefold(),
    ):
        name = distribution.metadata.get("Name") or "unknown"
        version = distribution.version
        copied = 0
        for file in distribution.files or []:
            filename = Path(str(file)).name.lower()
            if not any(
                marker in filename
                for marker in ("license", "licence", "copying", "notice")
            ):
                continue
            source = Path(distribution.locate_file(file))
            if not source.is_file():
                continue
            package_dir = destination / safe_name(f"{name}-{version}")
            package_dir.mkdir(exist_ok=True)
            target = package_dir / safe_name(Path(str(file)).name)
            if not target.exists():
                shutil.copy2(source, target)
                copied += 1
        license_expression = (
            distribution.metadata.get("License-Expression")
            or distribution.metadata.get("License")
            or "See project metadata"
        )
        manifest.append(
            f"{name} {version} | {license_expression} | license files: {copied}"
        )
    (destination / "MANIFEST.txt").write_text("\n".join(manifest) + "\n")


if __name__ == "__main__":
    main()
