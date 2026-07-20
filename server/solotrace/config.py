from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path


def store_mvsep_token(token: str) -> None:
    if sys.platform != "darwin":
        raise RuntimeError(
            "Keychain storage is available on macOS. Set SOLOTRACE_MVSEP_API_TOKEN "
            "before starting SoloTrace on this platform."
        )
    try:
        subprocess.run(
            [
                "security",
                "add-generic-password",
                "-a",
                "solotrace",
                "-s",
                "com.solotrace.mvsep",
                "-l",
                "SoloTrace MVSep API token",
                "-U",
                "-w",
                token,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Could not save MVSep token to macOS Keychain") from error


def _mvsep_token() -> str | None:
    configured = os.environ.get("SOLOTRACE_MVSEP_API_TOKEN")
    if configured is not None:
        return configured.strip() or None
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                "solotrace",
                "-s",
                "com.solotrace.mvsep",
                "-w",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    data_dir: Path
    web_dist: Path
    worker_dir: Path
    max_upload_bytes: int
    mvsep_api_token: str | None
    mvsep_api_base_url: str
    mvsep_poll_seconds: float
    mvsep_timeout_seconds: float

    @property
    def basic_pitch_python(self) -> Path:
        return self.worker_dir / "transcribe" / "bin" / "python"

    @property
    def basic_pitch_worker(self) -> Path:
        return Path(__file__).resolve().with_name("basic_pitch_worker.py")

    @property
    def basic_pitch_available(self) -> bool:
        return self.basic_pitch_python.is_file() and self.basic_pitch_worker.is_file()

    @property
    def cloud_pipeline_available(self) -> bool:
        return bool(self.mvsep_api_token) and self.basic_pitch_available

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
            mvsep_api_token=_mvsep_token(),
            mvsep_api_base_url=os.environ.get(
                "SOLOTRACE_MVSEP_API_BASE_URL",
                "https://de.mvsep.com/api",
            ).rstrip("/"),
            mvsep_poll_seconds=float(os.environ.get("SOLOTRACE_MVSEP_POLL_SECONDS", "2.5")),
            mvsep_timeout_seconds=float(
                os.environ.get("SOLOTRACE_MVSEP_TIMEOUT_SECONDS", "1800")
            ),
        )
