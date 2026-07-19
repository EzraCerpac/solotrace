from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    data_dir: Path
    web_dist: Path
    max_upload_bytes: int

    @classmethod
    def load(cls) -> Settings:
        root = Path(__file__).resolve().parents[2]
        packaged_web = Path(__file__).resolve().parent / "static"
        checkout_web = root / "web" / "dist"
        data = Path(
            os.environ.get("SOLOTRACE_DATA_DIR")
            or user_data_path("SoloTrace", "SoloTrace")
        ).expanduser()
        return cls(
            root_dir=root,
            data_dir=data,
            web_dist=(
                packaged_web
                if (packaged_web / "index.html").is_file()
                else checkout_web
            ),
            max_upload_bytes=int(os.environ.get("SOLOTRACE_MAX_UPLOAD_MB", "250"))
            * 1024
            * 1024,
        )
