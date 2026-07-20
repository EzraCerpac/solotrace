from __future__ import annotations

import io
import json
import shutil
import sqlite3
import zipfile

from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.imports import ProjectImportError, import_project_bundle
from solotrace.storage import SCHEMA_VERSION, ProjectStore


def _rewrite_project_id(bundle: bytes, project_id: str) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(bundle))
    output = io.BytesIO()
    with source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            payload = source.read(info)
            if info.filename.endswith("/project.json"):
                document = json.loads(payload)
                document["project"]["id"] = project_id
                payload = json.dumps(document).encode()
            target.writestr(info.filename, payload)
    return output.getvalue()


def test_bundle_round_trip_and_atomic_permanent_deletion(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    with TestClient(app) as client:
        original = client.get(f"/api/projects/{DEMO_ID}").json()
        bundle = client.get(f"/api/projects/{DEMO_ID}/export/bundle")
        assert bundle.status_code == 200
        imported_response = client.post(
            "/api/projects/import",
            files={
                "file": (
                    "northbound.solotrace.zip",
                    bundle.content,
                    "application/zip",
                )
            },
        )
        assert imported_response.status_code == 201
        imported = imported_response.json()
        assert imported["id"] != original["id"]
        assert imported["tab"]["notes"] == original["tab"]["notes"]
        assert imported["revision"] == original["revision"]
        assert imported["provenance"] == original["provenance"]
        assert imported["assets"]
        for asset in imported["assets"]:
            media = client.get(asset["url"])
            assert media.status_code == 200
            assert media.content

        stale = client.delete(
            f"/api/projects/{imported['id']}?expected_revision="
            f"{imported['revision'] + 1}"
        )
        assert stale.status_code == 409
        assert client.get(f"/api/projects/{imported['id']}").status_code == 200

        deleted = client.delete(
            f"/api/projects/{imported['id']}?expected_revision={imported['revision']}"
        )
        assert deleted.status_code == 204
        assert client.get(f"/api/projects/{imported['id']}").status_code == 404
        assert not (
            tmp_path / "data" / "projects" / imported["id"]
        ).exists()


def test_corrupt_bundle_leaves_library_untouched(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    with TestClient(app) as client:
        before = client.get("/api/projects?include_trashed=true").json()
        bundle = client.get(f"/api/projects/{DEMO_ID}/export/bundle").content
        unsafe_id = _rewrite_project_id(bundle, "../outside")
        response = client.post(
            "/api/projects/import",
            files={
                "file": (
                    "unsafe.solotrace.zip",
                    unsafe_id,
                    "application/zip",
                )
            },
        )
        assert response.status_code == 422

        traversal = io.BytesIO()
        with zipfile.ZipFile(traversal, "w") as archive:
            archive.writestr("../project.json", "{}")
        response = client.post(
            "/api/projects/import",
            files={
                "file": (
                    "traversal.solotrace.zip",
                    traversal.getvalue(),
                    "application/zip",
                )
            },
        )
        assert response.status_code == 422
        assert client.get("/api/projects?include_trashed=true").json() == before
        assert not (tmp_path / "outside").exists()


def test_bundle_expansion_limit_is_checked_before_writes(tmp_path) -> None:
    bundle = tmp_path / "large.solotrace.zip"
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("project/project.json", b"{" + b" " * 1024 + b"}")
    store = ProjectStore(tmp_path / "library")

    try:
        import_project_bundle(store, bundle, max_expanded_bytes=64)
    except ProjectImportError as error:
        assert "too large" in str(error)
    else:
        raise AssertionError("oversized expanded bundle was accepted")
    assert store.list() == []


def test_schema_migration_backs_up_and_restores_existing_library(tmp_path) -> None:
    data = tmp_path / "data"
    store = ProjectStore(data)
    project = ensure_demo(store)
    store.checkpoint()
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("PRAGMA user_version = 0")

    migrated = ProjectStore(data)
    restored = migrated.get(DEMO_ID)
    backups = sorted(migrated.backups_dir.glob("*schema-0*.sqlite3"))
    assert restored is not None
    assert restored.revision == project.revision
    assert migrated.integrity_check() == "ok"
    assert backups

    restore_data = tmp_path / "restored"
    restore_data.mkdir()
    shutil.copy2(backups[-1], restore_data / "solotrace.sqlite3")
    restored_store = ProjectStore(restore_data)
    restored_project = restored_store.get(DEMO_ID)
    assert restored_project is not None
    assert restored_project.tab.notes == project.tab.notes
    with sqlite3.connect(restored_store.database_path) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
    assert version == SCHEMA_VERSION
