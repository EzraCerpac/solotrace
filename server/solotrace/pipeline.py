from __future__ import annotations

import logging
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .audio import (
    AudioProcessingCancelled,
    AudioProcessingError,
    create_preview_stems,
    transcribe_pyin,
)
from .chords import (
    ChordRecognitionCancelled,
    ChordRecognitionUnavailable,
    recognition_capability,
    recognize_chords,
)
from .config import Settings
from .enhanced import transcribe_basic_pitch
from .models import (
    MediaAsset,
    Passage,
    PipelineStage,
    ProcessingEngine,
    ProcessingRun,
    Project,
    RunState,
    StageState,
    TabVersion,
    now_iso,
)
from .mvsep import MVSepCancelled, create_mvsep_stems
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
            PipelineStage(id="separate", label="Separate lead guitar"),
            PipelineStage(id="hear", label="Hear notes"),
            PipelineStage(id="rhythm", label="Match rhythm"),
            PipelineStage(id="fingering", label="Choose frets"),
            PipelineStage(id="chords", label="Find chords"),
        ],
    )


def new_chord_run() -> ProcessingRun:
    return ProcessingRun(
        id=f"run-{uuid.uuid4().hex[:12]}",
        state=RunState.queued,
        message="Waiting to find chords",
        stages=[PipelineStage(id="chords", label="Find chords")],
    )


class Pipeline:
    def __init__(self, store: ProjectStore, settings: Settings | None = None):
        self.store = store
        self.settings = settings or Settings.load()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="solotrace")
        self._project_jobs: dict[str, str] = {}
        self._project_cancellations: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._closing = False
        self._recover_interrupted_runs()

    def close(self) -> None:
        with self._lock:
            self._closing = True
            for event in self._project_cancellations.values():
                event.set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with self._lock:
                if not self._project_jobs:
                    break
            time.sleep(0.05)
        with self._lock:
            active = list(self._project_jobs.items())
        self.executor.shutdown(wait=not active, cancel_futures=True)
        for project_id, run_id in active:
            self._interrupt(project_id, run_id)

    def _recover_interrupted_runs(self) -> None:
        for project in self.store.list():
            if project.run.state in {RunState.queued, RunState.running}:
                self._interrupt(project.id, project.run.id)

    def _interrupt(self, project_id: str, run_id: str) -> None:
        def update(project: Project) -> Project:
            if project.run.id != run_id or project.run.state not in {
                RunState.queued,
                RunState.running,
            }:
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
        capo_fret: int = 0,
        preferred_fret: int | None = None,
        engine: ProcessingEngine = "preview",
        cloud_consent: bool = False,
    ) -> Project:
        if self._closing:
            raise RuntimeError("SoloTrace is shutting down")
        project = self.store.get(project_id)
        if project is None:
            raise KeyError(project_id)
        if end_s > project.duration_s + 0.01:
            raise ValueError("Selected range exceeds the song duration")
        if project.revision != expected_revision:
            raise RevisionConflictError(
                f"Expected revision {expected_revision}, current revision is {project.revision}"
            )
        if engine == "mvsep" and end_s - start_s > 600:
            raise ValueError("MVSep selections must be no longer than 10 minutes")
        if engine == "mvsep" and not cloud_consent:
            raise ValueError("Confirm MVSep cloud processing before creating this draft")
        if engine == "mvsep" and not self.settings.cloud_pipeline_available:
            raise ValueError(
                "MVSep cloud processing is not ready. Add an API token and install "
                "the Basic Pitch worker."
            )
        base_revision = expected_revision
        with self._lock:
            active = self._project_jobs.get(project_id)
            if active:
                raise RuntimeError("This project is already being processed")
            run = new_run()
            cancellation = threading.Event()
            self._project_jobs[project_id] = run.id
            self._project_cancellations[project_id] = cancellation

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
                self._project_cancellations.pop(project_id, None)
            raise RuntimeError("Notes changed while the draft was queued; try again") from error
        self.executor.submit(
            self._execute,
            project_id,
            run.id,
            base_revision,
            start_s,
            end_s,
            tuning,
            capo_fret,
            fret_count,
            preferred_fret,
            engine,
            cancellation,
        )
        return queued

    def cancel(self, project_id: str) -> Project:
        with self._lock:
            run_id = self._project_jobs.get(project_id)
            cancellation = self._project_cancellations.get(project_id)
            if run_id is None or cancellation is None:
                raise RuntimeError("This project has no active draft")
            cancellation.set()
        self._set_run(
            project_id,
            run_id,
            message="Cancelling draft",
        )
        project = self.store.get(project_id)
        if project is None:
            raise KeyError(project_id)
        return project

    def start_chords(
        self,
        project_id: str,
        version_id: str,
        *,
        start_s: float,
        end_s: float,
        expected_revision: int,
    ) -> Project:
        if self._closing:
            raise RuntimeError("SoloTrace is shutting down")
        available = recognition_capability()
        if not available["available"]:
            raise ChordRecognitionUnavailable(str(available["detail"]))
        project = self.store.get(project_id)
        if project is None:
            raise KeyError(project_id)
        if project.revision != expected_revision:
            raise RevisionConflictError(
                f"Expected revision {expected_revision}, current revision is {project.revision}"
            )
        if not any(version.id == version_id for version in project.versions):
            raise ValueError("Tab version not found")
        if (
            start_s < project.passage.start_s
            or end_s > min(project.passage.end_s, project.duration_s)
            or end_s <= start_s
        ):
            raise ValueError("Chord range must stay inside the transcription range")
        with self._lock:
            if self._project_jobs.get(project_id):
                raise RuntimeError("This project is already being processed")
            run = new_chord_run()
            cancellation = threading.Event()
            self._project_jobs[project_id] = run.id
            self._project_cancellations[project_id] = cancellation
        try:
            queued = self.store.update(
                project_id,
                lambda current: current.model_copy(update={"run": run}),
                reason="queue chord draft",
                expected_revision=expected_revision,
            )
        except RevisionConflictError:
            with self._lock:
                self._project_jobs.pop(project_id, None)
                self._project_cancellations.pop(project_id, None)
            raise
        self.executor.submit(
            self._execute_chords,
            project_id,
            version_id,
            run.id,
            expected_revision,
            start_s,
            end_s,
            cancellation,
        )
        return queued

    def cancel_and_wait(self, project_id: str, timeout_seconds: float = 15.0) -> bool:
        with self._lock:
            cancellation = self._project_cancellations.get(project_id)
            if cancellation is None:
                return True
            cancellation.set()
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            with self._lock:
                if project_id not in self._project_jobs:
                    return True
            time.sleep(0.05)
        return False

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
                elif state in {RunState.failed, RunState.cancelled} and stage.status in {
                    StageState.running,
                    StageState.pending,
                }:
                    stages.append(
                        stage.model_copy(
                            update={
                                "status": (
                                    StageState.failed
                                    if state == RunState.failed
                                    and stage.status == StageState.running
                                    else StageState.skipped
                                ),
                                "detail": (
                                    error or "Stage failed"
                                    if state == RunState.failed
                                    else "Cancelled"
                                ),
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
        capo_fret: int,
        fret_count: int,
        preferred_fret: int | None,
        engine: ProcessingEngine,
        cancellation: threading.Event,
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
                if engine == "mvsep":
                    assert self.settings.mvsep_api_token is not None

                    def separation_progress(detail: str) -> None:
                        self._set_run(
                            project_id,
                            run_id,
                            stage_id="separate",
                            stage_state=StageState.running,
                            message=detail,
                            detail=detail,
                        )

                    sample_rate, duration = create_mvsep_stems(
                        original,
                        temporary_lead,
                        temporary_backing,
                        start_s,
                        end_s,
                        temporary,
                        api_token=self.settings.mvsep_api_token,
                        base_url=self.settings.mvsep_api_base_url,
                        poll_seconds=self.settings.mvsep_poll_seconds,
                        timeout_seconds=self.settings.mvsep_timeout_seconds,
                        progress=separation_progress,
                        cancelled=cancellation.is_set,
                    )
                    separation_detail = "MVSep one-stage lead/rhythm model · lossless WAV"
                else:

                    def preview_progress(detail: str) -> None:
                        self._set_run(
                            project_id,
                            run_id,
                            stage_id="separate",
                            stage_state=StageState.running,
                            message="Listening for the guitar",
                            detail=detail,
                        )

                    sample_rate, duration = create_preview_stems(
                        original,
                        temporary_lead,
                        temporary_backing,
                        start_s,
                        end_s,
                        progress=preview_progress,
                        cancelled=cancellation.is_set,
                    )
                    separation_detail = (
                        "Fast local preview; guitar may share frequencies with other instruments"
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
                if cancellation.is_set():
                    raise MVSepCancelled("Draft cancelled")
                sounding_tuning = [pitch + capo_fret for pitch in tuning]
                available_frets = fret_count - capo_fret
                use_basic_pitch = engine == "mvsep" or self.settings.basic_pitch_available
                if use_basic_pitch:
                    tab = transcribe_basic_pitch(
                        temporary_lead,
                        original,
                        start_s,
                        end_s,
                        sample_rate,
                        sounding_tuning,
                        available_frets,
                        temporary,
                        self.settings.basic_pitch_command,
                        self.settings.basic_pitch_worker,
                        preferred_fret,
                    )
                    transcription_route = "Spotify Basic Pitch"
                else:

                    def transcription_progress(detail: str) -> None:
                        self._set_run(
                            project_id,
                            run_id,
                            stage_id="hear",
                            stage_state=StageState.running,
                            message="Hearing notes",
                            detail=detail,
                        )

                    tab = transcribe_pyin(
                        temporary_lead,
                        start_s,
                        end_s,
                        sounding_tuning,
                        available_frets,
                        rhythm_path=original,
                        progress=transcription_progress,
                        cancelled=cancellation.is_set,
                        preferred_fret=preferred_fret,
                    )
                    transcription_route = "librosa pYIN fallback"
                tab = tab.model_copy(
                    update={
                        "tuning": tuning,
                        "capo_fret": capo_fret,
                        "fret_count": fret_count,
                        "preferred_fret": preferred_fret,
                    }
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
                capability = recognition_capability()
                if capability["available"]:
                    self._set_run(
                        project_id,
                        run_id,
                        stage_id="chords",
                        stage_state=StageState.running,
                        message="Finding chords",
                    )
                    chord_track = recognize_chords(
                        original,
                        start_s,
                        end_s,
                        tab,
                        cancelled=cancellation.is_set,
                    )
                    tab = tab.model_copy(update={"chords": chord_track})
                    self._set_run(
                        project_id,
                        run_id,
                        stage_id="chords",
                        stage_state=StageState.complete,
                        detail=f"Found {len(chord_track.events)} chord spans",
                    )
                else:
                    self._set_run(
                        project_id,
                        run_id,
                        stage_id="chords",
                        stage_state=StageState.skipped,
                        detail=str(capability["detail"]),
                    )
                if cancellation.is_set():
                    raise MVSepCancelled("Draft cancelled")
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
                cloud = engine == "mvsep"
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
                                "MVSep one-stage lead-guitar estimate"
                                if cloud
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
                                "Original minus MVSep lead estimate"
                                if cloud
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
                existing_names = {version.name.casefold() for version in project.versions}
                version_name = "Lead draft"
                suffix = 2
                while version_name.casefold() in existing_names:
                    version_name = f"Lead draft {suffix}"
                    suffix += 1
                timestamp = now_iso()
                version = TabVersion(
                    id=f"version-{uuid.uuid4().hex[:12]}",
                    name=version_name,
                    source="mvsep" if cloud else "preview",
                    fingering_mode="balanced",
                    created_at=timestamp,
                    updated_at=timestamp,
                    tab=tab,
                )
                return project.model_copy(
                    update={
                        "assets": assets,
                        "passage": Passage(
                            name=(
                                "Full song"
                                if start_s <= 0.01 and end_s >= duration - 0.01
                                else "Selected section"
                            ),
                            start_s=start_s,
                            end_s=end_s,
                        ),
                        "versions": [*project.versions, version],
                        "active_version_id": version.id,
                        "run": complete_run,
                        "separation_scope": "solo-guitar" if cloud else "preview",
                        "provenance": (
                            [
                                "Audio decoded locally with FFmpeg.",
                                "Chosen audio range sent to MVSep's Germany region with "
                                "explicit consent.",
                                "MVSep one-stage Lead/Rhythm model estimated foreground "
                                "lead guitar; lossless 16-bit WAV returned.",
                                "Backing track created locally as original minus estimated lead.",
                                "Notes estimated locally with Spotify Basic Pitch; "
                                "beats estimated locally with librosa.",
                                "String and fret positions optimized for playability.",
                            ]
                            if cloud
                            else [
                                "Audio decoded locally with FFmpeg.",
                                "Preview stem uses harmonic, center-focused filtering; "
                                "it is not lead-only separation.",
                                f"Notes estimated locally with {transcription_route}; "
                                "beats estimated locally with librosa.",
                                "Instrument profile stores uncapoed tuning; sounding pitch "
                                "includes the capo.",
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
                    bump_revision=True,
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
        except (AudioProcessingCancelled, ChordRecognitionCancelled, MVSepCancelled):
            self._set_run(
                project_id,
                run_id,
                state=RunState.cancelled,
                message="Draft cancelled",
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
            logger.exception("Unexpected processing failure")
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Draft needs help",
                error="Unexpected processing error. Check the server log.",
            )
        finally:
            if not completed:
                for path in promoted:
                    path.unlink(missing_ok=True)
            with self._lock:
                if self._project_jobs.get(project_id) == run_id:
                    self._project_jobs.pop(project_id, None)
                    self._project_cancellations.pop(project_id, None)

    def _execute_chords(
        self,
        project_id: str,
        version_id: str,
        run_id: str,
        base_revision: int,
        start_s: float,
        end_s: float,
        cancellation: threading.Event,
    ) -> None:
        completed = False
        try:
            project = self.store.get(project_id)
            if project is None:
                raise KeyError(project_id)
            source = next(
                (version for version in project.versions if version.id == version_id),
                None,
            )
            if source is None:
                raise ValueError("Tab version not found")
            self._set_run(
                project_id,
                run_id,
                state=RunState.running,
                stage_id="chords",
                stage_state=StageState.running,
                message="Finding chords",
            )
            track = recognize_chords(
                self.store.project_dir(project_id) / "original.wav",
                start_s,
                end_s,
                source.tab,
                cancelled=cancellation.is_set,
            )
            if cancellation.is_set():
                raise ChordRecognitionCancelled("Chord recognition cancelled")

            def finish(current: Project) -> Project:
                current_source = next(
                    (version for version in current.versions if version.id == version_id),
                    None,
                )
                if current_source is None:
                    raise ValueError("Tab version not found")
                existing_names = {version.name.casefold() for version in current.versions}
                name = "Harmony draft"
                suffix = 2
                while name.casefold() in existing_names:
                    name = f"Harmony draft {suffix}"
                    suffix += 1
                timestamp = now_iso()
                version = TabVersion(
                    id=f"version-{uuid.uuid4().hex[:12]}",
                    name=name,
                    source=f"chords:{version_id}",
                    fingering_mode=current_source.fingering_mode,
                    created_at=timestamp,
                    updated_at=timestamp,
                    tab=current_source.tab.model_copy(update={"chords": track}),
                )
                run = current.run.model_copy(
                    update={
                        "state": RunState.complete,
                        "stages": [
                            stage.model_copy(
                                update={
                                    "status": StageState.complete,
                                    "detail": f"Found {len(track.events)} chord spans",
                                }
                            )
                            for stage in current.run.stages
                        ],
                        "message": "Harmony draft ready",
                        "error": None,
                        "updated_at": timestamp,
                    }
                )
                return current.model_copy(
                    update={
                        "versions": [*current.versions, version],
                        "active_version_id": version.id,
                        "run": run,
                    }
                )

            with self._lock:
                if self._closing:
                    raise PipelineInterrupted
                self.store.update(
                    project_id,
                    finish,
                    reason="create chord draft",
                    expected_revision=base_revision,
                    bump_revision=True,
                )
            completed = True
        except RevisionConflictError:
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Your edits are safe",
                error="The project changed while chords were running. Start again.",
            )
        except ChordRecognitionCancelled:
            self._set_run(
                project_id,
                run_id,
                state=RunState.cancelled,
                message="Chord draft cancelled",
            )
        except (ChordRecognitionUnavailable, PipelineInterrupted, ValueError, OSError) as error:
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Chord draft needs help",
                error=str(error),
            )
        except Exception:
            logger.exception("Unexpected chord-recognition failure")
            self._set_run(
                project_id,
                run_id,
                state=RunState.failed,
                message="Chord draft needs help",
                error="Unexpected chord-recognition error. Check the server log.",
            )
        finally:
            with self._lock:
                if self._project_jobs.get(project_id) == run_id:
                    self._project_jobs.pop(project_id, None)
                    self._project_cancellations.pop(project_id, None)
            if not completed:
                logger.info("Chord draft %s ended without publishing a version", run_id)
