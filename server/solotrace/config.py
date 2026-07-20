from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

import keyring
from keyring.errors import KeyringError, PasswordDeleteError
from platformdirs import user_data_path, user_log_path

from .version import BUILD_ID, PACKAGED

KEYCHAIN_SERVICE = "com.ezracerpac.solotrace"
KEYCHAIN_ACCOUNT = "mvsep"


def store_mvsep_token(token: str) -> None:
    if sys.platform != "darwin":
        raise RuntimeError(
            "Keychain storage is available on macOS. Set SOLOTRACE_MVSEP_API_TOKEN "
            "before starting SoloTrace on this platform."
        )
    try:
        keyring.set_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token)
    except KeyringError as error:
        raise RuntimeError("Could not save MVSep token to macOS Keychain") from error


def delete_mvsep_token() -> None:
    if sys.platform != "darwin":
        return
    try:
        keyring.delete_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    except PasswordDeleteError:
        return
    except KeyringError as error:
        raise RuntimeError("Could not remove MVSep token from macOS Keychain") from error


def _mvsep_token() -> str | None:
    if os.environ.get("SOLOTRACE_DISABLE_KEYCHAIN") == "1":
        return None
    configured = (
        os.environ.get("SOLOTRACE_MVSEP_API_TOKEN") if not PACKAGED else None
    )
    if configured is not None:
        return configured.strip() or None
    if sys.platform != "darwin":
        return None
    try:
        value = keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    except KeyringError:
        return None
    return value.strip() or None if value else None


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
    log_dir: Path = Path(".")
    packaged: bool = False
    build_id: str = "dev"

    @property
    def basic_pitch_command(self) -> tuple[str, ...]:
        if self.packaged:
            return (sys.executable, "--basic-pitch-worker")
        return (str(self.worker_dir / "transcribe" / "bin" / "python"),)

    @property
    def basic_pitch_worker(self) -> Path:
        return Path(__file__).resolve().with_name("basic_pitch_worker.py")

    @property
    def basic_pitch_available(self) -> bool:
        if self.packaged:
            try:
                __import__("basic_pitch")
            except ImportError:
                return False
            return self.basic_pitch_worker.is_file()
        return Path(self.basic_pitch_command[0]).is_file() and self.basic_pitch_worker.is_file()

    @property
    def cloud_pipeline_available(self) -> bool:
        return bool(self.mvsep_api_token) and self.basic_pitch_available

    @property
    def max_bundle_bytes(self) -> int:
        return self.max_upload_bytes * 6

    @classmethod
    def load(cls) -> Settings:
        root = Path(__file__).resolve().parents[2]
        packaged_web = Path(__file__).resolve().parent / "static"
        checkout_web = root / "web" / "dist"
        data_override = os.environ.get("SOLOTRACE_DATA_DIR")
        data = Path(
            data_override or user_data_path("SoloTrace", "SoloTrace")
        ).expanduser()
        log_override = os.environ.get("SOLOTRACE_LOG_DIR")
        log_dir = Path(
            log_override
            or (data / "logs" if data_override else user_log_path("SoloTrace", "SoloTrace"))
        ).expanduser()
        return cls(
            root_dir=root,
            data_dir=data,
            web_dist=packaged_web if PACKAGED else checkout_web,
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
            log_dir=log_dir,
            packaged=PACKAGED,
            build_id=BUILD_ID,
        )
