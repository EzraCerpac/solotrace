from __future__ import annotations

import tempfile
import unicodedata
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .audio import (
    AudioProcessingError,
    canonicalize_audio,
    ffmpeg_available,
    waveform_peaks,
)
from .config import Settings, store_mvsep_token
from .demo import DEMO_ID, ensure_demo
from .editing import normalize_edited_notes
from .exports import export_filename, export_payload, write_bundle
from .fingering import assign_fingerings
from .models import (
    HealthResponse,
    MediaAsset,
    MVSepTokenRequest,
    Passage,
    ProcessRequest,
    Project,
    ProjectMutationRequest,
    ProjectRenameRequest,
    ProjectSummary,
    ProjectView,
    RefingerRequest,
    RunState,
    TabDocument,
    TabPatch,
    TabVersion,
    TabVersionSummary,
    VersionCreateRequest,
    VersionRenameRequest,
    WorkspacePatch,
    now_iso,
)
from .pipeline import Pipeline, new_run
from .storage import ProjectStore, RevisionConflictError

ALLOWED_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.load()
    store = ProjectStore(settings.data_dir)
    ensure_demo(store)
    pipeline = Pipeline(store, settings)
    app.state.settings = settings
    app.state.store = store
    app.state.pipeline = pipeline
    yield
    pipeline.close()


app = FastAPI(
    title="SoloTrace",
    version="0.1.0",
    description="Local-first synchronized guitar solo tab studio",
    lifespan=lifespan,
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"],
)


@app.exception_handler(RequestValidationError)
async def safe_validation_error(
    _request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    detail = [
        {
            "type": item["type"],
            "loc": item["loc"],
            "msg": item["msg"],
        }
        for item in error.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.middleware("http")
async def protect_local_mutations(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin:
            hostname = urlsplit(origin).hostname
            if hostname not in {"127.0.0.1", "localhost", "::1"}:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "SoloTrace only accepts edits from its local app."},
                )
        if request.method == "POST" and request.url.path == "/api/projects":
            content_length = request.headers.get("content-length")
            settings = getattr(request.app.state, "settings", None)
            try:
                upload_size = int(content_length) if content_length else None
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Invalid Content-Length header."},
                )
            if settings is not None and upload_size is not None and (
                upload_size > settings.max_upload_bytes + 1024 * 1024
            ):
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Upload is larger than the configured limit."},
                )
    return await call_next(request)


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _project_or_404(store: ProjectStore, project_id: str) -> Project:
    project = store.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _version_or_404(project: Project, version_id: str) -> TabVersion:
    version = next(
        (candidate for candidate in project.versions if candidate.id == version_id),
        None,
    )
    if version is None:
        raise HTTPException(status_code=404, detail="Tab version not found")
    return version


def _version_summary(version: TabVersion) -> TabVersionSummary:
    return TabVersionSummary(
        id=version.id,
        name=version.name,
        source=version.source,
        fingering_mode=version.fingering_mode,
        created_at=version.created_at,
        updated_at=version.updated_at,
        note_count=len(version.tab.notes),
        needs_review_count=sum(
            not note.reviewed and note.confidence.minimum < 0.72
            for note in version.tab.notes
        ),
    )


def _project_summary(project: Project) -> ProjectSummary:
    active = _version_summary(project.active_version)
    return ProjectSummary(
        id=project.id,
        title=project.title,
        artist=project.artist,
        updated_at=project.updated_at,
        revision=project.revision,
        duration_s=project.duration_s,
        source_name=project.source_name,
        demo=project.demo,
        trashed_at=project.trashed_at,
        active_version_id=project.active_version_id,
        active_version_name=active.name,
        note_count=active.note_count,
        needs_review_count=active.needs_review_count,
    )


def _project_view(project: Project) -> ProjectView:
    return ProjectView(
        id=project.id,
        title=project.title,
        artist=project.artist,
        created_at=project.created_at,
        updated_at=project.updated_at,
        revision=project.revision,
        duration_s=project.duration_s,
        passage=project.passage,
        assets=project.assets,
        tab=project.tab,
        versions=[_version_summary(version) for version in project.versions],
        active_version_id=project.active_version_id,
        run=project.run,
        source_name=project.source_name,
        demo=project.demo,
        trashed_at=project.trashed_at,
        separation_scope=project.separation_scope,
        waveform_peaks=project.waveform_peaks,
        provenance=project.provenance,
    )


def _unique_version_name(project: Project, preferred: str) -> str:
    base = preferred.strip()
    existing = {version.name.casefold() for version in project.versions}
    if base.casefold() not in existing:
        return base
    index = 2
    while f"{base} {index}".casefold() in existing:
        index += 1
    return f"{base} {index}"


@app.get("/api/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    cloud = _settings(request).cloud_pipeline_available
    return HealthResponse(
        ffmpeg=ffmpeg_available(),
        separator="mvsep-one-stage" if cloud else "preview",
        transcriber="basic-pitch" if cloud else "pyin",
        demo_project_id=DEMO_ID,
    )


@app.get("/api/capabilities")
def capabilities(request: Request) -> dict[str, object]:
    settings = _settings(request)
    cloud = settings.cloud_pipeline_available
    return {
        "audio": {
            "ffmpeg": ffmpeg_available(),
            "maxUploadMb": settings.max_upload_bytes // 1024 // 1024,
        },
        "separation": {
            "selected": "mvsep" if cloud else "preview",
            "available": {
                "preview": True,
                "mvsep": cloud,
            },
            "notice": (
                "MVSep isolates foreground lead guitar in its Germany cloud region. "
                "Fast preview stays local and is used only when cloud processing is unavailable."
            ),
            "maxDurationS": 600,
            "consentRequired": True,
        },
        "transcription": {
            "selected": "basicPitch" if cloud else "pyin",
            "available": {
                "pyin": True,
                "basicPitch": settings.basic_pitch_available,
            },
        },
        "cloudReady": cloud,
        "privacy": (
            "Imports stay local. Creating a cloud lead draft sends only the selected "
            "audio to MVSep after explicit consent."
        ),
    }


@app.put("/api/settings/mvsep-token")
def save_mvsep_token(body: MVSepTokenRequest, request: Request) -> dict[str, object]:
    try:
        store_mvsep_token(body.api_token)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    settings = Settings.load()
    request.app.state.settings = settings
    request.app.state.pipeline.settings = settings
    return {
        "stored": True,
        "cloudReady": settings.cloud_pipeline_available,
    }


@app.get("/api/projects", response_model=list[ProjectSummary])
def list_projects(
    request: Request,
    include_trashed: bool = False,
) -> list[ProjectSummary]:
    return [
        _project_summary(project)
        for project in _store(request).list()
        if include_trashed or project.trashed_at is None
    ]


@app.get("/api/projects/{project_id}", response_model=ProjectView)
def get_project(project_id: str, request: Request) -> ProjectView:
    return _project_view(_project_or_404(_store(request), project_id))


def _slug(value: str) -> str:
    ascii_value = (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    slug = "".join(
        character.lower() if character.isalnum() else "-"
        for character in ascii_value
    )
    slug = "-".join(filter(None, slug.split("-")))
    return slug[:36] or "solo"


@app.post("/api/projects", response_model=ProjectView, status_code=201)
async def create_project(
    request: Request,
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1, max_length=120)],
    artist: Annotated[str, Form(max_length=120)] = "",
) -> Project:
    settings = _settings(request)
    store = _store(request)
    filename = Path(file.filename or "audio").name
    if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Choose WAV, MP3, M4A, FLAC, OGG, Opus, AIFF, or WebM audio.",
        )
    project_id = f"{_slug(title)}-{uuid.uuid4().hex[:12]}"
    size = 0
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".solotrace-import-",
        dir=settings.data_dir,
    ) as temporary_name:
        temporary = Path(temporary_name)
        upload_path = temporary / f"source{Path(filename).suffix.lower()}"
        decoded_path = temporary / "original.wav"
        try:
            with upload_path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                f"Audio is larger than "
                                f"{settings.max_upload_bytes // 1024 // 1024} MB."
                            ),
                        )
                    output.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="Uploaded file is empty")
            duration, sample_rate = await run_in_threadpool(
                canonicalize_audio,
                upload_path,
                decoded_path,
            )
            peaks = await run_in_threadpool(waveform_peaks, decoded_path)
            directory = store.project_dir(project_id)
            decoded_path.replace(directory / "original.wav")
        except AudioProcessingError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        finally:
            await file.close()

    initial_end = min(duration, max(4.0, duration))
    run = new_run().model_copy(update={"state": RunState.idle, "message": "Mark the solo"})
    project = Project(
        id=project_id,
        title=title.strip(),
        artist=artist.strip(),
        duration_s=duration,
        passage=Passage(name="Solo 1", start_s=0, end_s=initial_end),
        assets=[
            MediaAsset(
                role="original",
                url=f"/media/{project_id}/original.wav",
                filename="original.wav",
                duration_s=duration,
                sample_rate=sample_rate,
                method="Local FFmpeg decode",
            )
        ],
        versions=[
            TabVersion(
                id="version-original",
                name="Original draft",
                source="import",
                tab=TabDocument(sample_rate=sample_rate),
            )
        ],
        active_version_id="version-original",
        run=run,
        source_name=filename,
        waveform_peaks=peaks,
        provenance=["Audio decoded locally with FFmpeg. No cloud upload."],
    )
    return _project_view(store.put(project, reason="import audio"))


@app.post("/api/projects/{project_id}/process", response_model=ProjectView, status_code=202)
def process_project(
    project_id: str,
    body: ProcessRequest,
    request: Request,
) -> Project:
    try:
        return _project_view(
            request.app.state.pipeline.start(
                project_id,
                start_s=body.start_s,
                end_s=body.end_s,
                tuning=body.tuning,
                fret_count=body.fret_count,
                expected_revision=body.expected_revision,
                engine=body.engine,
                cloud_consent=body.cloud_consent,
            )
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/projects/{project_id}/process/cancel", response_model=ProjectView)
def cancel_process(project_id: str, request: Request) -> ProjectView:
    try:
        return _project_view(request.app.state.pipeline.cancel(project_id))
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.patch("/api/projects/{project_id}", response_model=ProjectView)
def rename_project(
    project_id: str,
    body: ProjectRenameRequest,
    request: Request,
) -> ProjectView:
    try:
        project = _store(request).update(
            project_id,
            lambda current: current.model_copy(
                update={"title": body.title.strip(), "artist": body.artist.strip()}
            ),
            reason="rename project",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.delete("/api/projects/{project_id}", response_model=ProjectView)
def trash_project(
    project_id: str,
    body: ProjectMutationRequest,
    request: Request,
) -> ProjectView:
    try:
        project = _store(request).update(
            project_id,
            lambda current: current.model_copy(update={"trashed_at": now_iso()}),
            reason="trash project",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/projects/{project_id}/restore", response_model=ProjectView)
def restore_project(
    project_id: str,
    body: ProjectMutationRequest,
    request: Request,
) -> ProjectView:
    try:
        project = _store(request).update(
            project_id,
            lambda current: current.model_copy(update={"trashed_at": None}),
            reason="restore project",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.patch("/api/projects/{project_id}/workspace", response_model=ProjectView)
def patch_workspace(
    project_id: str,
    body: WorkspacePatch,
    request: Request,
) -> ProjectView:
    try:
        project = _store(request).update(
            project_id,
            lambda current: current.model_copy(update={"passage": body.passage}),
            reason="update marked passage",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


def _create_version(project: Project, body: VersionCreateRequest) -> Project:
    if len(project.versions) >= 100:
        raise ValueError("A project can contain at most 100 tab versions")
    source = _version_or_404(project, body.source_version_id)
    mode = body.mode
    notes = source.tab.notes
    if mode is not None:
        unlocked = [
            note.model_copy(update={"user_locked": False})
            for note in source.tab.notes
        ]
        arranged = assign_fingerings(
            unlocked,
            source.tab.tuning,
            source.tab.fret_count,
            mode,
        )
        notes = [
            note.model_copy(
                update={
                    "reviewed": (
                        previous.reviewed
                        if (previous.string, previous.fret) == (note.string, note.fret)
                        else False
                    ),
                    "user_locked": False,
                }
            )
            for previous, note in zip(source.tab.notes, arranged, strict=True)
        ]
    default_names = {
        None: f"{source.name} copy",
        "balanced": "Balanced",
        "easiest": "Easiest",
        "position": "One position",
    }
    name = _unique_version_name(project, body.name or default_names[mode])
    timestamp = now_iso()
    version = TabVersion(
        id=f"version-{uuid.uuid4().hex[:12]}",
        name=name,
        source="duplicate" if mode is None else f"refinger-{mode}",
        fingering_mode=source.fingering_mode if mode is None else mode,
        created_at=timestamp,
        updated_at=timestamp,
        tab=source.tab.model_copy(update={"notes": notes}),
    )
    return project.model_copy(
        update={
            "versions": [*project.versions, version],
            "active_version_id": version.id,
        }
    )


@app.post("/api/projects/{project_id}/versions", response_model=ProjectView)
def create_version(
    project_id: str,
    body: VersionCreateRequest,
    request: Request,
) -> ProjectView:
    try:
        project = _store(request).update(
            project_id,
            lambda current: _create_version(current, body),
            reason=f"create tab version {body.mode or 'duplicate'}",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post(
    "/api/projects/{project_id}/versions/{version_id}/activate",
    response_model=ProjectView,
)
def activate_version(
    project_id: str,
    version_id: str,
    body: ProjectMutationRequest,
    request: Request,
) -> ProjectView:
    def update(project: Project) -> Project:
        _version_or_404(project, version_id)
        return project.model_copy(update={"active_version_id": version_id})

    try:
        project = _store(request).update(
            project_id,
            update,
            reason="activate tab version",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.patch(
    "/api/projects/{project_id}/versions/{version_id}",
    response_model=ProjectView,
)
def rename_version(
    project_id: str,
    version_id: str,
    body: VersionRenameRequest,
    request: Request,
) -> ProjectView:
    def update(project: Project) -> Project:
        _version_or_404(project, version_id)
        requested = body.name.strip()
        if any(
            version.id != version_id and version.name.casefold() == requested.casefold()
            for version in project.versions
        ):
            raise ValueError("Tab version names must be unique")
        versions = [
            version.model_copy(update={"name": requested, "updated_at": now_iso()})
            if version.id == version_id
            else version
            for version in project.versions
        ]
        return project.model_copy(update={"versions": versions})

    try:
        project = _store(request).update(
            project_id,
            update,
            reason="rename tab version",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.delete(
    "/api/projects/{project_id}/versions/{version_id}",
    response_model=ProjectView,
)
def delete_version(
    project_id: str,
    version_id: str,
    body: ProjectMutationRequest,
    request: Request,
) -> ProjectView:
    def update(project: Project) -> Project:
        _version_or_404(project, version_id)
        if len(project.versions) == 1:
            raise ValueError("Keep at least one tab version")
        versions = [version for version in project.versions if version.id != version_id]
        active_id = (
            versions[0].id
            if project.active_version_id == version_id
            else project.active_version_id
        )
        return project.model_copy(
            update={"versions": versions, "active_version_id": active_id}
        )

    try:
        project = _store(request).update(
            project_id,
            update,
            reason="delete tab version",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.patch(
    "/api/projects/{project_id}/versions/{version_id}/notes",
    response_model=ProjectView,
)
def patch_tab(
    project_id: str,
    version_id: str,
    body: TabPatch,
    request: Request,
) -> ProjectView:
    def update(project: Project) -> Project:
        _version_or_404(project, version_id)
        target = project.model_copy(update={"active_version_id": version_id})
        notes = normalize_edited_notes(target, body.notes)
        timestamp = now_iso()
        versions = [
            version.model_copy(
                update={
                    "tab": version.tab.model_copy(update={"notes": notes}),
                    "updated_at": timestamp,
                }
            )
            if version.id == version_id
            else version
            for version in project.versions
        ]
        return project.model_copy(update={"versions": versions})

    try:
        project = _store(request).update(
            project_id,
            update,
            reason="edit notes",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
        return _project_view(project)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/projects/{project_id}/refinger", response_model=ProjectView)
def refinger_project(
    project_id: str,
    body: RefingerRequest,
    request: Request,
) -> ProjectView:
    project = _project_or_404(_store(request), project_id)
    return create_version(
        project_id,
        VersionCreateRequest(
            expected_revision=body.expected_revision,
            source_version_id=project.active_version_id,
            mode=body.mode,
        ),
        request,
    )


@app.get("/api/projects/{project_id}/export/{format_name}")
def export_project(
    project_id: str,
    format_name: str,
    request: Request,
    version_id: str | None = None,
) -> Response:
    store = _store(request)
    project = _project_or_404(store, project_id)
    if version_id is not None:
        _version_or_404(project, version_id)
        project = project.model_copy(update={"active_version_id": version_id})
    if format_name == "bundle":
        try:
            filename = export_filename(project, format_name)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        temporary_dir = _settings(request).data_dir / "tmp"
        temporary_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="solotrace-export-",
            suffix=".zip",
            dir=temporary_dir,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
        try:
            write_bundle(project, store.project_dir(project_id), temporary_path)
        except FileNotFoundError as error:
            temporary_path.unlink(missing_ok=True)
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            temporary_path.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail=str(error)) from error
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
        return FileResponse(
            temporary_path,
            media_type="application/zip",
            filename=filename,
            background=BackgroundTask(temporary_path.unlink, missing_ok=True),
        )
    try:
        payload, media_type, filename = export_payload(
            project, store.project_dir(project_id), format_name
        )
    except ValueError as error:
        if "Unsupported export format" in str(error):
            raise HTTPException(status_code=404, detail=str(error)) from error
        raise HTTPException(status_code=422, detail=str(error)) from error
    return Response(
        content=payload,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/media/{project_id}/{filename}")
def media(project_id: str, filename: str, request: Request) -> FileResponse:
    store = _store(request)
    project = _project_or_404(store, project_id)
    if not any(asset.filename == filename for asset in project.assets):
        raise HTTPException(status_code=404, detail="Media not found")
    try:
        path = store.media_path(project_id, filename)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Media not found") from error
    if not path.is_file() or path.suffix.lower() not in {".wav", ".mp3", ".flac", ".m4a"}:
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(path, media_type="audio/wav", filename=None)


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str, request: Request) -> FileResponse:
    if path == "api" or path.startswith("api/") or path == "media" or path.startswith(
        "media/"
    ):
        raise HTTPException(status_code=404, detail="Route not found")
    web_dist = _settings(request).web_dist
    candidate = web_dist / path
    if path and candidate.is_file() and web_dist in candidate.resolve().parents:
        return FileResponse(candidate)
    index = web_dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(
        status_code=503,
        detail="Web app is not built. Run `pnpm --dir web build`.",
    )
