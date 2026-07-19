from __future__ import annotations

import stat
import threading
from pathlib import Path

import pytest
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.storage import ProjectStore, RevisionConflictError


def test_sqlite_revision_compare_and_swap_spans_store_instances(tmp_path: Path) -> None:
    first_store = ProjectStore(tmp_path)
    second_store = ProjectStore(tmp_path)
    project = ensure_demo(first_store)
    entered = threading.Event()
    release = threading.Event()
    outcomes: list[str] = []

    def slow_update() -> None:
        def mutate(current):
            entered.set()
            assert release.wait(timeout=5)
            return current

        first_store.update(
            DEMO_ID,
            mutate,
            reason="first",
            expected_revision=project.tab.revision,
            bump_revision=True,
        )
        outcomes.append("first")

    def competing_update() -> None:
        assert entered.wait(timeout=5)
        try:
            second_store.update(
                DEMO_ID,
                lambda current: current,
                reason="second",
                expected_revision=project.tab.revision,
                bump_revision=True,
            )
        except RevisionConflictError:
            outcomes.append("conflict")

    first = threading.Thread(target=slow_update)
    second = threading.Thread(target=competing_update)
    first.start()
    second.start()
    assert entered.wait(timeout=5)
    release.set()
    first.join(timeout=5)
    second.join(timeout=5)

    assert sorted(outcomes) == ["conflict", "first"]


def test_demo_refresh_preserves_edits_and_private_permissions(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    edited = store.update(
        DEMO_ID,
        lambda current: current.model_copy(
            update={"title": "My edited demo"}
        ),
        reason="edit demo",
        expected_revision=project.tab.revision,
        bump_revision=True,
    )
    (store.project_dir(DEMO_ID) / "backing.wav").unlink()

    refreshed = ensure_demo(store)

    assert refreshed.title == "My edited demo"
    assert refreshed.tab.revision == edited.tab.revision
    assert (store.project_dir(DEMO_ID) / "backing.wav").is_file()
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert stat.S_IMODE(store.projects_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(store.database_path.stat().st_mode) == 0o600


def test_invalid_expected_revision_is_not_silently_accepted(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    with pytest.raises(RevisionConflictError):
        store.update(
            DEMO_ID,
            lambda current: current,
            reason="stale",
            expected_revision=project.tab.revision + 1,
        )
