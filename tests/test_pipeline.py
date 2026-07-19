from __future__ import annotations

import shutil
import time

import soundfile as sf
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
                            StageState.running
                            if stage.id == "separate"
                            else StageState.pending
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
        expected_revision=project.tab.revision,
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


def test_enhanced_pipeline_records_honest_provenance(tmp_path, monkeypatch) -> None:
    store = ProjectStore(tmp_path / "data")
    project = ensure_demo(store)
    worker_dir = tmp_path / "workers"
    demucs = worker_dir / "separate" / "bin" / "demucs-mlx"
    basic_pitch = worker_dir / "transcribe" / "bin" / "python"
    demucs.parent.mkdir(parents=True)
    basic_pitch.parent.mkdir(parents=True)
    demucs.touch()
    basic_pitch.touch()
    settings = Settings(
        root_dir=tmp_path,
        data_dir=tmp_path / "data",
        web_dist=tmp_path,
        worker_dir=worker_dir,
        max_upload_bytes=1_000_000,
    )

    def fake_stems(original, lead, backing, *_args):
        shutil.copyfile(original, lead)
        shutil.copyfile(original, backing)
        info = sf.info(original)
        return info.samplerate, info.duration

    def fake_transcription(*_args) -> TabDocument:
        return project.tab

    monkeypatch.setattr("solotrace.pipeline.create_enhanced_stems", fake_stems)
    monkeypatch.setattr("solotrace.pipeline.transcribe_basic_pitch", fake_transcription)
    pipeline = Pipeline(store, settings)
    pipeline.start(
        DEMO_ID,
        start_s=1,
        end_s=5,
        tuning=project.tab.tuning,
        fret_count=project.tab.fret_count,
        expected_revision=project.tab.revision,
        engine="enhanced",
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
    assert finished.separation_scope == "all-guitar"
    assert finished.asset("lead").method == "Demucs htdemucs_6s guitar estimate"
    assert any("Basic Pitch" in item for item in finished.provenance)
