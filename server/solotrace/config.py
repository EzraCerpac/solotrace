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
    worker_dir: Path
    max_upload_bytes: int

    @property
    def demucs_executable(self) -> Path:
        return self.worker_dir / "separate" / "bin" / "demucs-mlx"

    @property
    def basic_pitch_python(self) -> Path:
        return self.worker_dir / "transcribe" / "bin" / "python"

    @property
    def basic_pitch_worker(self) -> Path:
        return Path(__file__).resolve().with_name("basic_pitch_worker.py")

    @property
    def enhanced_models_available(self) -> bool:
        return (
            self.demucs_executable.is_file()
            and self.basic_pitch_python.is_file()
            and self.basic_pitch_worker.is_file()
        )

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
            worker_dir=Path(
                os.environ.get("SOLOTRACE_WORKER_DIR") or root / ".workers"
            ).expanduser(),
            max_upload_bytes=int(os.environ.get("SOLOTRACE_MAX_UPLOAD_MB", "250"))
            * 1024
            * 1024,
        )
