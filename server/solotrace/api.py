from __future__ import annotations

import hmac
import os
import secrets
import shutil
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
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.background import BackgroundTask
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .audio import (
    AudioProcessingError,
    canonicalize_audio,
    ffmpeg_available,
    probe_audio,
    waveform_peaks,
)
from .config import Settings, delete_mvsep_token, store_mvsep_token
from .demo import DEMO_ID, ensure_demo
from .diagnostics import configure_logging, diagnostic_bundle
from .editing import normalize_edited_notes
from .exports import export_filename, export_payload, write_bundle
from .fingering import assign_fingerings
from .imports import ProjectImportError, import_project_bundle
from .models import (
    HealthResponse,
    MediaAsset,
    MVSepTokenRequest,
    Passage,
    ProcessRequest,
    Project,
    RefingerRequest,
    RunState,
    TabDocument,
    TabPatch,
)
from .pipeline import Pipeline, new_run
from .storage import ProjectStore, RevisionConflictError
from .version import APP_VERSION, BUILD_ID, PACKAGED

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
    configure_logging(settings)
    store = ProjectStore(settings.data_dir)
    ensure_demo(store)
    pipeline = Pipeline(store, settings)
    app.state.settings = settings
    app.state.store = store
    app.state.pipeline = pipeline
    app.state.launch_secret = os.environ.get("SOLOTRACE_LAUNCH_SECRET")
    app.state.session_secret = (
        os.environ.get("SOLOTRACE_SESSION_SECRET") or secrets.token_urlsafe(32)
        if app.state.launch_secret
        else None
    )
    try:
        yield
    finally:
        pipeline.close()
        store.checkpoint()


app = FastAPI(
    title="SoloTrace",
    version=APP_VERSION,
    description="Local-first synchronized guitar solo tab studio",
    lifespan=lifespan,
    docs_url=None if PACKAGED else "/docs",
    redoc_url=None if PACKAGED else "/redoc",
    openapi_url=None if PACKAGED else "/openapi.json",
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
    if request.url.path.startswith(("/api", "/media")):
        session_secret = getattr(request.app.state, "session_secret", None)
        session = request.cookies.get("solotrace_session")
        if session_secret and (
            session is None or not hmac.compare_digest(session, session_secret)
        ):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
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


@app.get("/bootstrap", include_in_schema=False)
async def bootstrap(request: Request, token: str) -> RedirectResponse:
    launch_secret = getattr(request.app.state, "launch_secret", None)
    if not launch_secret or not hmac.compare_digest(token, launch_secret):
        raise HTTPException(status_code=401, detail="Invalid launch token")
    request.app.state.launch_secret = None
    session_secret = request.app.state.session_secret
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        "solotrace_session",
        session_secret,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/",
    )
    return response


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _project_or_404(store: ProjectStore, project_id: str) -> Project:
    project = store.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


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
        "appVersion": APP_VERSION,
        "buildId": BUILD_ID,
        "packaged": settings.packaged,
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
                "Experimental MVSep lead estimate uploads only the selected range "
                "to MVSep's Germany region after per-run consent."
            ),
            "maxDurationS": 600,
            "previewMaxDurationS": 180,
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
        "cloud": {
            "configured": bool(settings.mvsep_api_token),
            "ready": cloud,
        },
        "privacy": (
            "Imports stay local. Creating a cloud lead draft sends only the selected "
            "audio to MVSep after explicit consent."
        ),
    }


@app.put("/api/settings/mvsep-key")
def save_mvsep_key(body: MVSepTokenRequest, request: Request) -> dict[str, object]:
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


@app.delete("/api/settings/mvsep-key", status_code=204)
def remove_mvsep_key(request: Request) -> Response:
    try:
        delete_mvsep_token()
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    settings = Settings.load()
    request.app.state.settings = settings
    request.app.state.pipeline.settings = settings
    return Response(status_code=204)


@app.get("/api/projects", response_model=list[Project])
def list_projects(request: Request) -> list[Project]:
    return _store(request).list()


@app.get("/api/projects/{project_id}", response_model=Project)
def get_project(project_id: str, request: Request) -> Project:
    return _project_or_404(_store(request), project_id)


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


def _ensure_decode_space(path: Path, data_dir: Path) -> None:
    duration, _sample_rate = probe_audio(path)
    decoded_bytes = int(duration * 44_100 * 2 * 2)
    required = decoded_bytes * 3 + 64 * 1024 * 1024
    if shutil.disk_usage(data_dir).free < required:
        raise AudioProcessingError(
            "Not enough free disk space to import this audio safely"
        )


@app.post("/api/projects", response_model=Project, status_code=201)
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
            await run_in_threadpool(_ensure_decode_space, upload_path, settings.data_dir)
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
        tab=TabDocument(sample_rate=sample_rate),
        run=run,
        source_name=filename,
        waveform_peaks=peaks,
        provenance=["Audio decoded locally with FFmpeg. No cloud upload."],
    )
    return store.put(project, reason="import audio")


@app.post("/api/projects/import", response_model=Project, status_code=201)
async def import_project(
    request: Request,
    file: Annotated[UploadFile, File()],
) -> Project:
    settings = _settings(request)
    store = _store(request)
    filename = Path(file.filename or "").name
    if not filename.lower().endswith(".solotrace.zip"):
        raise HTTPException(status_code=415, detail="Choose a .solotrace.zip project")
    size = 0
    with tempfile.TemporaryDirectory(
        prefix=".solotrace-bundle-import-",
        dir=settings.data_dir,
    ) as temporary_name:
        bundle_path = Path(temporary_name) / "project.solotrace.zip"
        try:
            with bundle_path.open("xb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_bundle_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="Project bundle is larger than the configured limit.",
                        )
                    output.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="Project bundle is empty")
            return await run_in_threadpool(
                import_project_bundle,
                store,
                bundle_path,
                max_expanded_bytes=settings.max_bundle_bytes,
            )
        except ProjectImportError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        finally:
            await file.close()


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    expected_revision: int,
    request: Request,
) -> Response:
    if project_id == DEMO_ID:
        raise HTTPException(status_code=409, detail="The built-in demo cannot be deleted")
    store = _store(request)
    _project_or_404(store, project_id)
    if not request.app.state.pipeline.cancel_and_wait(project_id):
        raise HTTPException(
            status_code=409,
            detail="Draft is still stopping. Try deleting the project again.",
        )
    try:
        store.delete(project_id, expected_revision)
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/process", response_model=Project, status_code=202)
def process_project(
    project_id: str,
    body: ProcessRequest,
    request: Request,
) -> Project:
    try:
        return request.app.state.pipeline.start(
            project_id,
            start_s=body.start_s,
            end_s=body.end_s,
            tuning=body.tuning,
            fret_count=body.fret_count,
            expected_revision=body.expected_revision,
            engine=body.engine,
            cloud_consent=body.cloud_consent,
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/projects/{project_id}/process/cancel", response_model=Project)
def cancel_process(project_id: str, request: Request) -> Project:
    try:
        return request.app.state.pipeline.cancel(project_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/projects/{project_id}/refinger", response_model=Project)
def refinger_project(
    project_id: str,
    body: RefingerRequest,
    request: Request,
) -> Project:
    store = _store(request)

    def update(project: Project) -> Project:
        notes = assign_fingerings(
            project.tab.notes,
            project.tab.tuning,
            project.tab.fret_count,
            body.mode,
        )
        return project.model_copy(
            update={"tab": project.tab.model_copy(update={"notes": notes})}
        )

    try:
        return store.update(
            project_id,
            update,
            reason=f"refinger {body.mode}",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.patch("/api/projects/{project_id}/tab", response_model=Project)
def patch_tab(project_id: str, body: TabPatch, request: Request) -> Project:
    store = _store(request)

    def update(project: Project) -> Project:
        notes = normalize_edited_notes(project, body.notes)
        return project.model_copy(
            update={"tab": project.tab.model_copy(update={"notes": notes})}
        )

    try:
        return store.update(
            project_id,
            update,
            reason="edit notes",
            expected_revision=body.expected_revision,
            bump_revision=True,
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except RevisionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/diagnostics/export")
def export_diagnostics(request: Request) -> Response:
    payload = diagnostic_bundle(_settings(request), _store(request))
    filename = f"solotrace-diagnostics-{APP_VERSION}.zip"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/projects/{project_id}/export/{format_name}")
def export_project(project_id: str, format_name: str, request: Request) -> Response:
    store = _store(request)
    project = _project_or_404(store, project_id)
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
