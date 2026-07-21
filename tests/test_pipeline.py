from __future__ import annotations

import shutil
import threading
import time

import soundfile as sf
from solotrace.audio import AudioProcessingCancelled
from solotrace.config import Settings
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.models import RunState, StageState, TabDocument
from solotrace.pipeline import Pipeline, new_run
from solotrace.storage import ProjectStore


def test_startup_terminalizes_orphaned_processing_run(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    run = new_run()
    orphan = run.model_copy(
        update={
            "state": RunState.running,
            "stages": [
                stage.model_copy(
                    update={
                        "status": (
                            StageState.running if stage.id == "separate" else StageState.pending
                        )
                    }
                )
                for stage in run.stages
            ],
        }
    )
    store.update(
        DEMO_ID,
        lambda current: current.model_copy(update={"run": orphan}),
        reason="simulate crash",
        expected_revision=project.revision,
    )

    pipeline = Pipeline(store)
    recovered = store.get(DEMO_ID)
    pipeline.close()

    assert recovered is not None
    assert recovered.run.state == RunState.failed
    assert recovered.run.error is not None
    assert all(
        stage.status not in {StageState.pending, StageState.running}
        for stage in recovered.run.stages
    )


def test_offline_pipeline_cancels_during_chunked_processing(tmp_path, monkeypatch) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    entered = threading.Event()

    def wait_for_cancellation(*_args, cancelled, **_kwargs):
        entered.set()
        while not cancelled():
            time.sleep(0.005)
        raise AudioProcessingCancelled("Draft cancelled")

    monkeypatch.setattr("solotrace.pipeline.create_preview_stems", wait_for_cancellation)
    pipeline = Pipeline(store)
    pipeline.start(
        DEMO_ID,
        start_s=0,
        end_s=project.duration_s,
        tuning=project.tab.tuning,
        fret_count=project.tab.fret_count,
        expected_revision=project.revision,
    )
    assert entered.wait(timeout=1)
    pipeline.cancel(DEMO_ID)

    deadline = time.monotonic() + 2
    cancelled = store.get(DEMO_ID)
    while cancelled is not None and cancelled.run.state in {RunState.queued, RunState.running}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
        cancelled = store.get(DEMO_ID)
    pipeline.close()

    assert cancelled is not None
    assert cancelled.run.state == RunState.cancelled


def test_mvsep_pipeline_records_honest_provenance(tmp_path, monkeypatch) -> None:
    store = ProjectStore(tmp_path / "data")
    project = ensure_demo(store)
    worker_dir = tmp_path / "workers"
    basic_pitch = worker_dir / "transcribe" / "bin" / "python"
    basic_pitch.parent.mkdir(parents=True)
    basic_pitch.touch()
    settings = Settings(
        root_dir=tmp_path,
        data_dir=tmp_path / "data",
        web_dist=tmp_path,
        worker_dir=worker_dir,
        max_upload_bytes=1_000_000,
        mvsep_api_token="test-token",
        mvsep_api_base_url="https://de.mvsep.com/api",
        mvsep_poll_seconds=0,
        mvsep_timeout_seconds=60,
    )

    def fake_stems(original, lead, backing, *_args, **_kwargs):
        shutil.copyfile(original, lead)
        shutil.copyfile(original, backing)
        info = sf.info(original)
        return info.samplerate, info.duration

    def fake_transcription(*_args, **_kwargs) -> TabDocument:
        return project.tab

    monkeypatch.setattr("solotrace.pipeline.create_mvsep_stems", fake_stems)
    monkeypatch.setattr("solotrace.pipeline.transcribe_basic_pitch", fake_transcription)
    pipeline = Pipeline(store, settings)
    pipeline.start(
        DEMO_ID,
        start_s=1,
        end_s=5,
        tuning=project.tab.tuning,
        fret_count=project.tab.fret_count,
        expected_revision=project.revision,
        engine="mvsep",
        cloud_consent=True,
    )

    deadline = time.monotonic() + 2
    finished = store.get(DEMO_ID)
    while finished is not None and finished.run.state in {RunState.queued, RunState.running}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
        finished = store.get(DEMO_ID)
    pipeline.close()

    assert finished is not None
    assert finished.run.state == RunState.complete
    assert len(finished.versions) == len(project.versions) + 1
    assert finished.active_version.name == "Lead draft"
    assert finished.versions[0].tab == project.tab
    assert finished.separation_scope == "solo-guitar"
    assert finished.asset("lead").method == "MVSep one-stage lead-guitar estimate"
    assert any("MVSep" in item for item in finished.provenance)
    assert any("Basic Pitch" in item for item in finished.provenance)
