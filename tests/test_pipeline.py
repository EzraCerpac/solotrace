from __future__ import annotations

from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.models import RunState, StageState
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
