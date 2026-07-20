from __future__ import annotations

import stat
import threading
from pathlib import Path

import pytest
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.models import Project
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
            expected_revision=project.revision,
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
                expected_revision=project.revision,
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
        expected_revision=project.revision,
        bump_revision=True,
    )
    (store.project_dir(DEMO_ID) / "backing.wav").unlink()

    refreshed = ensure_demo(store)

    assert refreshed.title == "My edited demo"
    assert refreshed.revision == edited.revision
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
            expected_revision=project.revision + 1,
        )


def test_legacy_single_tab_project_migrates_without_losing_revision(tmp_path: Path) -> None:
    project = ensure_demo(ProjectStore(tmp_path))
    payload = project.model_dump(mode="python")
    version = payload.pop("versions")[0]
    payload.pop("active_version_id")
    payload.pop("revision")
    payload["tab"] = {**version["tab"], "revision": 7}
    payload["tab"]["notes"][0].pop("reviewed")

    migrated = Project.model_validate(payload)

    assert migrated.revision == 7
    assert migrated.active_version_id == "version-demo"
    assert len(migrated.versions) == 1
    assert migrated.versions[0].name == "Demo tab"
    assert migrated.tab.notes[0].reviewed is False


def test_library_merge_keeps_newest_revision_and_copies_declared_media(
    tmp_path: Path,
) -> None:
    source = ProjectStore(tmp_path / "temporary")
    destination = ProjectStore(tmp_path / "persistent")
    ensure_demo(destination)
    source_project = ensure_demo(source)
    source_project = source.update(
        DEMO_ID,
        lambda current: current.model_copy(update={"title": "Newest edit"}),
        reason="newer source",
        expected_revision=source_project.revision,
        bump_revision=True,
    )

    assert destination.merge_from(source) == [DEMO_ID]
    merged = destination.get(DEMO_ID)
    assert merged is not None
    assert merged.title == "Newest edit"
    assert merged.revision == source_project.revision
    for asset in merged.assets:
        copied = destination.media_path(DEMO_ID, asset.filename)
        assert copied.is_file()
        assert copied.stat().st_size == source.media_path(
            DEMO_ID, asset.filename
        ).stat().st_size

    assert destination.merge_from(source) == []
