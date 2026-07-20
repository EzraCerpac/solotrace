from __future__ import annotations

import fcntl
import html
import logging
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
from contextlib import suppress
from pathlib import Path
from types import TracebackType
from typing import IO, Any
from urllib.parse import quote

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class AlreadyRunning(RuntimeError):
    pass


class InstanceLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle: IO[str] | None = None

    def __enter__(self) -> InstanceLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+", encoding="utf-8")
        self.path.chmod(0o600)
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self.handle.close()
            self.handle = None
            raise AlreadyRunning("SoloTrace is already open") from error
        return self

    def __exit__(
        self,
        _error_type: type[BaseException] | None,
        _error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        if self.handle is not None:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()


class LocalServer:
    def __init__(self, app: Any):
        import uvicorn

        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(128)
        self.port = int(self.socket.getsockname()[1])
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self.port,
            log_config=None,
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(
            target=self._serve,
            name="solotrace-api",
            daemon=True,
        )
        self.error: BaseException | None = None

    def _serve(self) -> None:
        try:
            self.server.run(sockets=[self.socket])
        except BaseException as error:
            self.error = error
            logger.exception("Desktop API failed")

    def start(self) -> None:
        self.thread.start()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.server.started:
                return
            if not self.thread.is_alive():
                break
            time.sleep(0.05)
        if self.error is not None:
            raise RuntimeError("SoloTrace could not start its local service") from self.error
        raise RuntimeError("SoloTrace local service did not become ready")

    def stop(self, *_args: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=15)
        with suppress(OSError):
            self.socket.close()


class DesktopBridge:
    _FORMATS = {"bundle", "json", "musicxml", "midi", "ascii"}

    def __init__(
        self,
        *,
        base_url: str,
        session_secret: str,
        data_dir: Path,
    ):
        self.base_url = base_url
        self.session_secret = session_secret
        self.data_dir = data_dir
        self.window: Any = None

    def _download(self, path: str) -> tuple[bytes, str]:
        with httpx.Client(
            base_url=self.base_url,
            cookies={"solotrace_session": self.session_secret},
            timeout=120,
        ) as client:
            response = client.get(path)
            response.raise_for_status()
        disposition = response.headers.get("content-disposition", "")
        match = re.search(r'filename="?([^";]+)', disposition)
        filename = Path(match.group(1)).name if match else "solotrace-export"
        return response.content, filename

    def _save(self, payload: bytes, filename: str, file_type: str) -> dict[str, object]:
        import webview

        selected = self.window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=filename,
            file_types=(file_type, "All files (*.*)"),
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        destination = Path(selected[0] if isinstance(selected, list | tuple) else selected)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}-",
            dir=destination.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(destination)
        return {"ok": True}

    def saveExport(self, projectId: str, formatName: str) -> dict[str, object]:
        try:
            if formatName not in self._FORMATS:
                raise ValueError("Unsupported export format")
            payload, filename = self._download(
                f"/api/projects/{quote(projectId, safe='')}/export/{formatName}"
            )
            return self._save(payload, filename, "SoloTrace export (*.*)")
        except Exception:
            logger.exception("Native export failed")
            return {"ok": False, "error": "SoloTrace could not save this export."}

    def saveDiagnostics(self) -> dict[str, object]:
        try:
            payload, filename = self._download("/api/diagnostics/export")
            return self._save(payload, filename, "ZIP archive (*.zip)")
        except Exception:
            logger.exception("Native diagnostic export failed")
            return {"ok": False, "error": "SoloTrace could not save diagnostics."}

    def revealDataFolder(self) -> dict[str, object]:
        try:
            from AppKit import NSWorkspace

            self.data_dir.mkdir(parents=True, exist_ok=True)
            NSWorkspace.sharedWorkspace().selectFile_inFileViewerRootedAtPath_(
                None,
                str(self.data_dir),
            )
            return {"ok": True}
        except Exception:
            logger.exception("Could not reveal data folder")
            return {"ok": False, "error": "SoloTrace could not reveal its data folder."}


def _worker() -> None:
    if len(sys.argv) > 2 and sys.argv[2].endswith("basic_pitch_worker.py"):
        del sys.argv[2]
    del sys.argv[1]
    from .basic_pitch_worker import main

    main()


def _show_failure(message: str) -> None:
    import webview

    body = html.escape(message)
    webview.create_window(
        "SoloTrace",
        html=(
            "<main style='font:16px -apple-system;padding:40px;max-width:620px'>"
            "<h1>SoloTrace could not start</h1>"
            f"<p>{body}</p><p>Your projects were not changed.</p></main>"
        ),
        width=720,
        height=440,
    )
    webview.start()


def _configure_bundled_tools() -> None:
    resources = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    ffmpeg = resources / "ffmpeg" / "bin" / "ffmpeg"
    ffprobe = resources / "ffmpeg" / "bin" / "ffprobe"
    if ffmpeg.is_file() and ffprobe.is_file():
        os.environ["SOLOTRACE_FFMPEG"] = str(ffmpeg)
        os.environ["SOLOTRACE_FFPROBE"] = str(ffprobe)


def run() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--basic-pitch-worker":
        _worker()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        from .self_test import run as self_test

        self_test()
        return

    import webview

    _configure_bundled_tools()
    launch_secret = secrets.token_urlsafe(32)
    session_secret = secrets.token_urlsafe(32)
    os.environ["SOLOTRACE_LAUNCH_SECRET"] = launch_secret
    os.environ["SOLOTRACE_SESSION_SECRET"] = session_secret
    settings = Settings.load()
    try:
        with InstanceLock(settings.data_dir / "solotrace.lock"):
            from .api import app

            server = LocalServer(app)
            server.start()
            base_url = f"http://127.0.0.1:{server.port}"
            bridge = DesktopBridge(
                base_url=base_url,
                session_secret=session_secret,
                data_dir=settings.data_dir,
            )
            window = webview.create_window(
                "SoloTrace",
                f"{base_url}/bootstrap?token={quote(launch_secret, safe='')}",
                js_api=bridge,
                width=1320,
                height=860,
                min_size=(900, 650),
            )
            bridge.window = window
            window.events.closed += server.stop
            try:
                webview.start(gui="cocoa", debug=False)
            finally:
                server.stop()
    except AlreadyRunning as error:
        _show_failure(str(error))
    except Exception:
        logger.exception("SoloTrace desktop startup failed")
        _show_failure(
            "Check the SoloTrace diagnostic log in Library/Logs/SoloTrace, "
            "then try opening the app again."
        )


if __name__ == "__main__":
    run()
