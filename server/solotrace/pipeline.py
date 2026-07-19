from __future__ import annotations

import logging
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .audio import AudioProcessingError, create_preview_stems, transcribe_pyin
from .config import Settings
from .enhanced import create_enhanced_stems, transcribe_basic_pitch
from .models import (
    MediaAsset,
    Passage,
    PipelineStage,
    ProcessingEngine,
    ProcessingRun,
    Project,
    RunState,
    StageState,
    now_iso,
)
from .storage import ProjectStore, RevisionConflictError

logger = logging.getLogger(__name__)


class PipelineInterrupted(RuntimeError):
    pass


def new_run() -> ProcessingRun:
    return ProcessingRun(
        id=f"run-{uuid.uuid4().hex[:12]}",
        state=RunState.queued,
        message="Waiting to create draft",
        stages=[
            PipelineStage(id="separate", label="Separate guitar"),
            PipelineStage(id="hear", label="Hear notes"),
            PipelineStage(id="rhythm", label="Match rhythm"),
            PipelineStage(id="fingering", label="Choose frets"),
        ],
    )


class Pipeline:
    def __init__(self, store: ProjectStore, settings: Settings | None = None):
        self.store = store
        self.settings = settings or Settings.load()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="solotrace")
        self._project_jobs: dict[str, str] = {}
        self._lock = threading.RLock()
        self._closing = False
        self._recover_interrupted_runs()

    def close(self) -> None:
        with self._lock:
            self._closing = True
            active = list(self._project_jobs.items())
        self.executor.shutdown(wait=False, cancel_futures=True)
        for project_id, run_id in active:
            self._interrupt(project_id, run_id)

    def _recover_interrupted_runs(self) -> None:
        for project in self.store.list():
            if project.run.state in {RunState.queued, RunState.running}:
                self._interrupt(project.id, project.run.id)

    def _interrupt(self, project_id: str, run_id: str) -> None:
        def update(project: Project) -> Project:
            if (
                project.run.id != run_id
                or project.run.state not in {RunState.queued, RunState.running}
            ):
                return project
            stages = [
                stage.model_copy(
                    update={
                        "status": (
                            StageState.failed
                            if stage.status == StageState.running
                            else StageState.skipped
                            if stage.status == StageState.pending
                            else stage.status
                        ),
                        "detail": (
                            "Interrupted when SoloTrace stopped"
                            if stage.status in {StageState.running, StageState.pending}
                            else stage.detail
                        ),
                    }
                )
                for stage in project.run.stages
            ]
            run = project.run.model_copy(
                update={
                    "state": RunState.failed,
                    "stages": stages,
                    "message": "Draft was interrupted",
                    "error": "SoloTrace stopped before this draft finished. Start it again.",
                    "updated_at": now_iso(),
                }
            )
            return project.model_copy(update={"run": run})

        self.store.update(project_id, update, reason="interrupt draft")

    def start(
        self,
        project_id: str,
        *,
        start_s: float,
        end_s: float,
        tuning: list[int],
        fret_count: int,
        expected_revision: int,
        engine: ProcessingEngine = "preview",
    ) -> Project:
        if self._closing:
            raise RuntimeError("SoloTrace is shutting down")
        project = self.store.get(project_id)
        if project is None:
            raise KeyError(project_id)
        if end_s > project.duration_s + 0.01:
            raise ValueError("solo end exceeds the song duration")
        if project.tab.revision != expected_revision:
            raise RevisionConflictError(
                f"Expected revision {expected_revision}, current revision is "
                f"{project.tab.revision}"
            )
        if end_s - start_s > 180:
            raise ValueError("Mark a solo no longer than 3 minutes")
        if engine == "enhanced" and not self.settings.enhanced_models_available:
            raise ValueError(
                "Enhanced models are not installed. Run "
                "`./scripts/install-enhanced-models.sh` or choose Fast preview."
            )
        base_revision = expected_revision
        with self._lock:
            active = self._project_jobs.get(project_id)
            if active:
                raise RuntimeError("This project is already being processed")
            run = new_run()
            self._project_jobs[project_id] = run.id

        try:
            queued = self.store.update(
                project_id,
                lambda current: current.model_copy(
                    update={
                        "run": run,
                    }
                ),
                reason="queue draft",
                expected_revision=base_revision,
            )
        except RevisionConflictError as error:
            with self._lock:
                self._project_jobs.pop(project_id, None)
            raise RuntimeError("Notes changed while the draft was queued; try again") from error
        self.executor.submit(
            self._execute,
            project_id,
            run.id,
            base_revision,
            start_s,
            end_s,
            tuning,
            fret_count,
            engine,
        )
        return queued

    def _set_run(
        self,
        project_id: str,
        run_id: str,
        *,
        state: RunState | None = None,
        stage_id: str | None = None,
        stage_state: StageState | None = None,
        message: str | None = None,
        detail: str = "",
        error: str | None = None,
    ) -> None:
        def update(project: Project) -> Project:
            if project.run.id != run_id:
                return project
            stages: list[PipelineStage] = []
            for stage in project.run.stages:
                if stage.id == stage_id and stage_state is not None:
                    stages.append(
                        stage.model_copy(
                            update={
                                "status": stage_state,
                                "detail": detail,
                            }
                        )
                    )
                elif state == RunState.failed and stage.status == StageState.running:
                    stages.append(
                        stage.model_copy(
                            update={
                                "status": StageState.failed,
                                "detail": error or "Stage failed",
                            }
                        )
                    )
                else:
                    stages.append(stage)
            run = project.run.model_copy(
                update={
                    "state": state or project.run.state,
                    "stages": stages,
                    "message": message if message is not None else project.run.message,
                    "error": error,
                    "updated_at": now_iso(),
                }
            )
            return project.model_copy(update={"run": run})

        self.store.update(project_id, update, reason="pipeline progress")

    def _execute(
        self,
        project_id: str,
        run_id: str,
        base_revision: int,
        start_s: float,
        end_s: float,
        tuning: list[int],
        fret_count: int,
        engine: ProcessingEngine,
    ) -> None:
        directory = self.store.project_dir(project_id)
        original = directory / "original.wav"
        promoted: list[Path] = []
        completed = False
        try:
            with tempfile.TemporaryDirectory(
                prefix=f".{run_id}-",
                dir=directory,
            ) as temporary_name:
                temporary = Path(temporary_name)
                temporary_lead = temporary / "lead.wav"
                temporary_backing = temporary / "backing.wav"
                self._set_run(
                    project_id,
                    run_id,
                    state=RunState.running,
                    stage_id="separate",
                    stage_state=StageState.running,
                    message="Listening for the guitar",
                )
                if engine == "enhanced":
                    sample_rate, duration = create_enhanced_stems(
                        original,
                        temporary_lead,
                        temporary_backing,
                        start_s,
                        end_s,
                        temporary,
                        self.settings.demucs_executable,
                    )
                    separation_detail = (
                        "Demucs htdemucs_6s; every guitar in the marked passage"
                    )
                else:
                    sample_rate, duration = create_preview_stems(
                        original,
                        temporary_lead,
                        temporary_backing,
                        start_s,
                        end_s,
                    )
                    separation_detail = (
                        "Fast local preview; guitar may share frequencies with "
                        "other instruments"
                    )
                self._set_run(
                    project_id,
                    run_id,
                    stage_id="separate",
                    stage_state=StageState.complete,
                    message="Hearing notes",
                    detail=separation_detail,
                )
                self._set_run(
                    project_id,
                    run_id,
                    stage_id="hear",
                    stage_state=StageState.running,
                )
                if engine == "enhanced":
                    tab = transcribe_basic_pitch(
                        temporary_lead,
                        original,
                        start_s,
                        end_s,
                        sample_rate,
                        tuning,
                        fret_count,
                        temporary,
                        self.settings.basic_pitch_python,
                        self.settings.basic_pitch_worker,
                    )
                else:
                    tab = transcribe_pyin(
                        temporary_lead,
                        start_s,
                        end_s,
                        tuning,
                        fret_count,
                        rhythm_path=original,
                    )
                self._set_run(
                    project_id,
                    run_id,
                    stage_id="hear",
                    stage_state=StageState.complete,
                    message="Matching the rhythm",
                    detail=f"Found {len(tab.notes)} note events",
                )
                self._set_run(
                    project_id,
                    run_id,
                    stage_id="rhythm",
                    stage_state=StageState.complete,
                    message="Choosing playable frets",
                    detail=f"Estimated {tab.tempo_bpm:.1f} BPM",
                )
                self._set_run(
                    project_id,
                    run_id,
                    stage_id="fingering",
                    stage_state=StageState.complete,
                )
                if self._closing:
                    raise PipelineInterrupted

                lead_filename = f"lead-{run_id}.wav"
                backing_filename = f"backing-{run_id}.wav"
                temporary_lead.replace(directory / lead_filename)
                temporary_backing.replace(directory / backing_filename)
                promoted = [
                    directory / lead_filename,
                    directory / backing_filename,
                ]

            superseded: list[str] = []

            def finish(project: Project) -> Project:
                enhanced = engine == "enhanced"
                superseded.extend(
                    asset.filename
                    for asset in project.assets
                    if asset.role in {"lead", "backing"}
                    and (
                        asset.filename.startswith("lead-run-")
                        or asset.filename.startswith("backing-run-")
                    )
                )
                assets = [asset for asset in project.assets if asset.role == "original"]
                assets.extend(
                    [
                        MediaAsset(
                            role="lead",
                            url=f"/media/{project_id}/{lead_filename}",
                            filename=lead_filename,
                            duration_s=duration,
                            sample_rate=sample_rate,
                            method=(
                                "Demucs htdemucs_6s guitar estimate"
                                if enhanced
                                else "Local frequency-focused preview"
                            ),
                        ),
                        MediaAsset(
                            role="backing",
                            url=f"/media/{project_id}/{backing_filename}",
                            filename=backing_filename,
                            duration_s=duration,
                            sample_rate=sample_rate,
                            method=(
                                "Original minus Demucs guitar estimate in marked passage"
                                if enhanced
                                else "Original minus frequency-focused preview"
                            ),
                        ),
                    ]
                )
                complete_run = project.run.model_copy(
                    update={
                        "state": RunState.complete,
                        "message": "Draft ready",
                        "error": None,
                        "updated_at": now_iso(),
                    }
                )
                return project.model_copy(
                    update={
                        "assets": assets,
                        "passage": Passage(
                            name=project.passage.name,
                            start_s=start_s,
                            end_s=end_s,
                        ),
                        "tab": tab.model_copy(update={"revision": project.tab.revision + 1}),
                        "run": complete_run,
                        "separation_scope": "all-guitar" if enhanced else "preview",
                        "provenance": (
                            [
                                "Audio decoded locally with FFmpeg.",
                                "Demucs htdemucs_6s estimated every guitar in the "
                                "marked passage; it does not distinguish lead from rhythm.",
                                "Notes estimated locally with Spotify Basic Pitch; "
                                "beats estimated locally with librosa.",
                                "String and fret positions optimized for playability.",
                            ]
                            if enhanced
                            else [
                                "Audio decoded locally with FFmpeg.",
                                "Preview stem uses harmonic, center-focused filtering; "
                                "it is not lead-only separation.",
                                "Notes and beats estimated locally with librosa pYIN "
                                "and beat tracking.",
                                "String and fret positions optimized for playability.",
                            ]
                        ),
                    }
                )

            with self._lock:
                if self._closing:
                    raise PipelineInterrupted
                self.store.update(
                    project_id,
                    finish,
                    reason="create draft",
                    expected_revision=base_revision,
                )
            completed = True
            for filename in superseded:
                if filename not in {lead_filename, backing_filename}:
                    (directory / filename).unlink(missing_ok=True)
        except RevisionConflictError:
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Your edits are safe",
                error=(
                    "Notes changed while this draft was running. Start a new draft "
                    "when you are ready."
                ),
            )
        except (AudioProcessingError, PipelineInterrupted, ValueError, OSError) as error:
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Draft needs help",
                error=str(error),
            )
        except Exception:
            logger.exception("Unexpected processing failure for %s", project_id)
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Draft needs help",
                error="Unexpected local processing error. Check the server log.",
            )
        finally:
            if not completed:
                for path in promoted:
                    path.unlink(missing_ok=True)
            with self._lock:
                if self._project_jobs.get(project_id) == run_id:
                    self._project_jobs.pop(project_id, None)
