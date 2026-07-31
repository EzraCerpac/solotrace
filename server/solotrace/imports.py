from __future__ import annotations

import json
import shutil
import stat
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from pydantic import ValidationError

from .audio import AudioProcessingError, probe_audio
from .exports import PROJECT_FORMAT, PROJECT_SCHEMA_VERSION
from .models import ProcessingRun, Project, RunState, now_iso
from .storage import ProjectStore

MAX_BUNDLE_FILES = 32


class ProjectImportError(ValueError):
    pass


def _safe_member(info: zipfile.ZipInfo) -> PurePosixPath:
    path = PurePosixPath(info.filename)
    if (
        path.is_absolute()
        or ".." in path.parts
        or not path.parts
        or any(part in {"", "."} for part in path.parts)
    ):
        raise ProjectImportError("Project bundle contains an unsafe path")
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise ProjectImportError("Project bundle cannot contain symbolic links")
    return path


def _project_payload(raw: bytes) -> dict[str, object]:
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProjectImportError("Project bundle contains unreadable project data") from error
    if not isinstance(payload, dict):
        raise ProjectImportError("Project bundle contains invalid project data")
    if payload.get("format") == PROJECT_FORMAT:
        if payload.get("schemaVersion") not in range(1, PROJECT_SCHEMA_VERSION + 1):
            raise ProjectImportError("Project bundle uses an unsupported schema version")
        project = payload.get("project")
        if not isinstance(project, dict):
            raise ProjectImportError("Project bundle has no project document")
        return project
    # Import the pre-envelope 0.1 beta format once so existing manual backups remain useful.
    if {"id", "tab", "assets"}.issubset(payload):
        return payload
    raise ProjectImportError("File is not a SoloTrace project bundle")


def import_project_bundle(
    store: ProjectStore,
    bundle_path: Path,
    *,
    max_expanded_bytes: int,
) -> Project:
    try:
        archive = zipfile.ZipFile(bundle_path)
    except (OSError, zipfile.BadZipFile) as error:
        raise ProjectImportError("Choose a readable .solotrace.zip project") from error
    with archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_BUNDLE_FILES:
            raise ProjectImportError("Project bundle contains too many files")
        if len({info.filename for info in infos}) != len(infos):
            raise ProjectImportError("Project bundle contains duplicate paths")
        paths = {info.filename: _safe_member(info) for info in infos}
        total_size = sum(info.file_size for info in infos)
        if total_size > max_expanded_bytes:
            raise ProjectImportError("Project bundle is too large when expanded")
        project_entries = [
            (name, path)
            for name, path in paths.items()
            if len(path.parts) == 2 and path.name == "project.json"
        ]
        if len(project_entries) != 1:
            raise ProjectImportError("Project bundle must contain one project document")
        project_name, project_path = project_entries[0]
        root = project_path.parts[0]
        try:
            project = Project.model_validate(_project_payload(archive.read(project_name)))
        except (KeyError, ValidationError) as error:
            raise ProjectImportError("Project bundle contains invalid project data") from error

        project_id = project.id
        if not project_id or any(
            character not in "abcdefghijklmnopqrstuvwxyz0123456789-"
            for character in project_id
        ):
            raise ProjectImportError("Project bundle contains an unsafe project identifier")
        if store.get(project_id) is not None:
            project_id = f"{project_id[:36].rstrip('-')}-{uuid.uuid4().hex[:12]}"
        declared: dict[str, zipfile.ZipInfo] = {}
        for asset in project.assets:
            if Path(asset.filename).name != asset.filename:
                raise ProjectImportError("Project bundle declares an unsafe media filename")
            if asset.filename in declared:
                raise ProjectImportError("Project bundle declares duplicate media")
            member_name = f"{root}/audio/{asset.filename}"
            try:
                declared[asset.filename] = archive.getinfo(member_name)
            except KeyError as error:
                raise ProjectImportError(
                    f"Project bundle is missing declared {asset.role} audio"
                ) from error

        run = ProcessingRun(
            id=f"import-{uuid.uuid4().hex[:12]}",
            state=RunState.idle,
            message="Imported project",
        )
        imported = project.model_copy(
            update={
                "id": project_id,
                "demo": False,
                "trashed_at": None,
                "run": run,
                "updated_at": now_iso(),
                "assets": [
                    asset.model_copy(
                        update={"url": f"/media/{project_id}/{asset.filename}"}
                    )
                    for asset in project.assets
                ],
            }
        )
        imported = Project.model_validate(imported.model_dump(mode="python"))

        with tempfile.TemporaryDirectory(
            prefix=".solotrace-project-import-",
            dir=store.data_dir,
        ) as temporary_name:
            staged = Path(temporary_name) / project_id
            staged.mkdir(mode=0o700)
            for filename, info in declared.items():
                destination = staged / filename
                try:
                    with archive.open(info) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
                except (OSError, zipfile.BadZipFile) as error:
                    raise ProjectImportError("Project bundle contains damaged audio") from error
                asset = next(
                    candidate
                    for candidate in imported.assets
                    if candidate.filename == filename
                )
                try:
                    duration, sample_rate = probe_audio(destination)
                except AudioProcessingError as error:
                    raise ProjectImportError(
                        f"Project bundle contains unreadable {asset.role} audio"
                    ) from error
                if (
                    abs(duration - asset.duration_s) > max(0.25, asset.duration_s * 0.02)
                    or sample_rate != asset.sample_rate
                ):
                    raise ProjectImportError(
                        f"Project bundle {asset.role} audio does not match its declaration"
                    )
            final = store.projects_dir / project_id
            if final.exists():
                raise ProjectImportError("A project with this identifier already exists")
            staged.replace(final)
            try:
                return store.put(imported, reason="import project bundle")
            except Exception:
                shutil.rmtree(final, ignore_errors=True)
                raise
