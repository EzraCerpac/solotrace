from __future__ import annotations

import io
import json
import zipfile

from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.demo import DEMO_ID


def _patch_notes(client: TestClient, project: dict, notes: list[dict]) -> dict:
    response = client.patch(
        (
            f"/api/projects/{project['id']}/versions/"
            f"{project['active_version_id']}/notes"
        ),
        json={"expected_revision": project["revision"], "notes": notes},
    )
    assert response.status_code == 200
    return response.json()


def test_note_review_delete_and_undo_are_versioned_and_persistent(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        original_count = len(project["tab"]["notes"])
        note = next(
            candidate
            for candidate in project["tab"]["notes"]
            if min(candidate["confidence"].values()) < 0.72
        )
        initial_review_count = next(
            version["needs_review_count"]
            for version in project["versions"]
            if version["id"] == project["active_version_id"]
        )

        accepted = {**note, "reviewed": True}
        notes = [
            accepted if candidate["id"] == note["id"] else candidate
            for candidate in project["tab"]["notes"]
        ]
        project = _patch_notes(client, project, notes)
        assert next(
            version["needs_review_count"]
            for version in project["versions"]
            if version["id"] == project["active_version_id"]
        ) == initial_review_count - 1
        persisted = client.get(f"/api/projects/{DEMO_ID}").json()
        assert next(
            candidate
            for candidate in persisted["tab"]["notes"]
            if candidate["id"] == note["id"]
        )["reviewed"]

        reopened = {**accepted, "reviewed": False}
        notes = [
            reopened if candidate["id"] == note["id"] else candidate
            for candidate in project["tab"]["notes"]
        ]
        project = _patch_notes(client, project, notes)
        assert next(
            version["needs_review_count"]
            for version in project["versions"]
            if version["id"] == project["active_version_id"]
        ) == initial_review_count

        project = _patch_notes(
            client,
            project,
            [candidate for candidate in project["tab"]["notes"] if candidate["id"] != note["id"]],
        )
        assert len(project["tab"]["notes"]) == original_count - 1
        project = _patch_notes(
            client,
            project,
            sorted(
                [*project["tab"]["notes"], reopened],
                key=lambda candidate: (
                    candidate["audio_onset_s"],
                    candidate["midi_pitch"],
                ),
            ),
        )
        assert len(project["tab"]["notes"]) == original_count
        assert any(candidate["id"] == note["id"] for candidate in project["tab"]["notes"])


def test_styles_create_versions_without_changing_the_source(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        source_id = project["active_version_id"]
        reviewed_notes = [
            {**note, "reviewed": True, "user_locked": True}
            for note in project["tab"]["notes"]
        ]
        project = _patch_notes(client, project, reviewed_notes)
        source_notes = project["tab"]["notes"]
        source_positions = {
            note["id"]: (note["string"], note["fret"]) for note in source_notes
        }
        for mode, name in (
            ("balanced", "Balanced"),
            ("easiest", "Easiest"),
            ("position", "One position"),
        ):
            response = client.post(
                f"/api/projects/{DEMO_ID}/versions",
                json={
                    "expected_revision": project["revision"],
                    "source_version_id": source_id,
                    "mode": mode,
                },
            )
            assert response.status_code == 200
            project = response.json()
            assert project["versions"][-1]["name"] == name
            assert project["active_version_id"] != source_id
            for note in project["tab"]["notes"]:
                assert source_positions[note["id"]] == (note["string"], note["fret"])
                assert note["reviewed"] is True
                assert note["user_locked"] is True

        response = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": project["revision"],
                "source_version_id": source_id,
                "mode": "easiest",
                "lock_policy": "clear",
                "name": "Start fresh",
            },
        )
        assert response.status_code == 200
        project = response.json()
        assert all(not note["user_locked"] for note in project["tab"]["notes"])
        response = client.post(
            f"/api/projects/{DEMO_ID}/versions/{source_id}/activate",
            json={"expected_revision": project["revision"]},
        )
        assert response.status_code == 200
        project = response.json()
        assert project["tab"]["notes"] == source_notes


def test_version_and_project_management_with_conflict_protection(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        original_id = project["active_version_id"]
        duplicate = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": project["revision"],
                "source_version_id": original_id,
                "name": "Working copy",
                "mode": None,
            },
        )
        assert duplicate.status_code == 200
        project = duplicate.json()
        copy_id = project["active_version_id"]
        assert project["tab"]["notes"]

        renamed_version = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{copy_id}",
            json={"expected_revision": project["revision"], "name": "My take"},
        )
        assert renamed_version.status_code == 200
        project = renamed_version.json()
        assert any(
            version["id"] == copy_id and version["name"] == "My take"
            for version in project["versions"]
        )

        renamed_project = client.patch(
            f"/api/projects/{DEMO_ID}",
            json={
                "expected_revision": project["revision"],
                "title": "Reviewed lead",
                "artist": "SoloTrace",
            },
        )
        assert renamed_project.status_code == 200
        project = renamed_project.json()
        assert (project["title"], project["artist"]) == ("Reviewed lead", "SoloTrace")

        stale = client.patch(
            f"/api/projects/{DEMO_ID}",
            json={
                "expected_revision": project["revision"] - 1,
                "title": "Lost edit",
                "artist": "",
            },
        )
        assert stale.status_code == 409
        assert client.get(f"/api/projects/{DEMO_ID}").json()["title"] == "Reviewed lead"

        passage = {"name": "Marked phrase", "start_s": 1.0, "end_s": 4.0}
        workspace = client.patch(
            f"/api/projects/{DEMO_ID}/workspace",
            json={"expected_revision": project["revision"], "passage": passage},
        )
        assert workspace.status_code == 200
        project = workspace.json()
        assert project["passage"] == passage

        deleted = client.request(
            "DELETE",
            f"/api/projects/{DEMO_ID}/versions/{original_id}",
            json={"expected_revision": project["revision"]},
        )
        assert deleted.status_code == 200
        project = deleted.json()
        last_delete = client.request(
            "DELETE",
            f"/api/projects/{DEMO_ID}/versions/{copy_id}",
            json={"expected_revision": project["revision"]},
        )
        assert last_delete.status_code == 409

        trashed = client.post(
            f"/api/projects/{DEMO_ID}/trash",
            json={"expected_revision": project["revision"]},
        )
        assert trashed.status_code == 200
        project = trashed.json()
        assert project["trashed_at"]
        assert all(
            summary["id"] != DEMO_ID for summary in client.get("/api/projects").json()
        )
        assert any(
            summary["id"] == DEMO_ID
            for summary in client.get("/api/projects?include_trashed=true").json()
        )

        restored = client.post(
            f"/api/projects/{DEMO_ID}/restore",
            json={"expected_revision": project["revision"]},
        )
        assert restored.status_code == 200
        assert restored.json()["trashed_at"] is None


def test_active_exports_choose_one_version_and_bundle_keeps_all(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        source_id = project["active_version_id"]
        created = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": project["revision"],
                "source_version_id": source_id,
                "name": "Second voice",
                "mode": None,
            },
        )
        project = created.json()
        active_id = project["active_version_id"]

        exported_json = client.get(
            f"/api/projects/{DEMO_ID}/export/json?version_id={source_id}"
        )
        assert exported_json.status_code == 200
        manifest = json.loads(exported_json.content)
        assert manifest["format"] == "solotrace-project"
        assert manifest["schemaVersion"] == 3
        assert manifest["project"]["active_version_id"] == source_id
        assert [
            version["id"] for version in manifest["project"]["versions"]
        ] == [source_id]

        for format_name in ("musicxml", "midi"):
            response = client.get(
                f"/api/projects/{DEMO_ID}/export/{format_name}?version_id={active_id}"
            )
            assert response.status_code == 200
            assert response.content

        response = client.get(f"/api/projects/{DEMO_ID}/export/bundle")
        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            names = set(archive.namelist())
        assert f"{DEMO_ID}/versions/{source_id}/tab.musicxml" in names
        assert f"{DEMO_ID}/versions/{active_id}/tab.musicxml" in names
