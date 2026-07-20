from __future__ import annotations

import io
import json
import logging
import platform
import re
import zipfile
from collections import Counter
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import Settings
from .storage import SCHEMA_VERSION, ProjectStore
from .version import APP_VERSION

LOG_FILENAME = "solotrace.log"
MAX_DIAGNOSTIC_LOG_BYTES = 200_000


def configure_logging(settings: Settings) -> Path:
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    settings.log_dir.chmod(0o700)
    path = settings.log_dir / LOG_FILENAME
    root = logging.getLogger()
    if not any(
        isinstance(handler, RotatingFileHandler)
        and Path(handler.baseFilename) == path
        for handler in root.handlers
    ):
        handler = RotatingFileHandler(
            path,
            maxBytes=1_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
        root.addHandler(handler)
    root.setLevel(logging.INFO)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    return path


def _redact(text: str) -> str:
    home = str(Path.home())
    if home:
        text = text.replace(home, "<home>")
    text = re.sub(r"/(?:private/)?var/folders/\S+", "<temporary-path>", text)
    text = re.sub(
        r"\b[a-z0-9][a-z0-9-]{0,36}-[0-9a-f]{12}\b",
        "<project-id>",
        text,
    )
    text = re.sub(
        r"(?i)(api[_ -]?token|api[_ -]?key|authorization)([\"':=\s]+)\S+",
        r"\1\2<redacted>",
        text,
    )
    return text


def _recent_log(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - MAX_DIAGNOSTIC_LOG_BYTES))
            raw = handle.read()
    except OSError:
        return ""
    return _redact(raw.decode("utf-8", errors="replace"))


def diagnostic_bundle(settings: Settings, store: ProjectStore) -> bytes:
    log_path = configure_logging(settings)
    projects = store.list()
    run_states = Counter(project.run.state.value for project in projects)
    failed_stages = Counter(
        stage.id
        for project in projects
        for stage in project.run.stages
        if stage.status.value == "failed"
    )
    details = {
        "appVersion": APP_VERSION,
        "buildId": settings.build_id,
        "packaged": settings.packaged,
        "platform": {
            "system": platform.system(),
            "release": platform.mac_ver()[0] or platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "capabilities": {
            "basicPitch": settings.basic_pitch_available,
            "mvsepConfigured": bool(settings.mvsep_api_token),
            "cloudReady": settings.cloud_pipeline_available,
        },
        "storage": {
            "schemaVersion": SCHEMA_VERSION,
            "integrity": store.integrity_check(),
            "projectCount": len(projects),
            "runStates": dict(sorted(run_states.items())),
            "failedStages": dict(sorted(failed_stages.items())),
        },
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "diagnostic.json",
            json.dumps(details, indent=2, sort_keys=True) + "\n",
        )
        archive.writestr(LOG_FILENAME, _recent_log(log_path))
    return output.getvalue()
