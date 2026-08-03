from __future__ import annotations

import json
import logging
import zipfile
from io import BytesIO

from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.config import (
    KEYCHAIN_ACCOUNT,
    KEYCHAIN_SERVICE,
    Settings,
    delete_mvsep_token,
    store_mvsep_token,
)
from solotrace.demo import DEMO_ID


def test_development_runtime_uses_checkout_ui_and_isolated_logs(
    tmp_path,
    monkeypatch,
) -> None:
    data_dir = tmp_path / "data"
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(data_dir))
    monkeypatch.delenv("SOLOTRACE_LOG_DIR", raising=False)

    settings = Settings.load()

    assert settings.web_dist == settings.root_dir / "web" / "dist"
    assert settings.log_dir == data_dir / "logs"


def test_packaged_launch_secret_becomes_one_time_http_only_session(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOLOTRACE_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("SOLOTRACE_LAUNCH_SECRET", "one-time-launch-secret")
    monkeypatch.setenv("SOLOTRACE_SESSION_SECRET", "private-session-secret")

    with TestClient(app) as client:
        assert client.get("/api/projects").status_code == 401
        bootstrap = client.get(
            "/bootstrap?token=one-time-launch-secret",
            follow_redirects=False,
        )
        assert bootstrap.status_code == 303
        cookie = bootstrap.headers["set-cookie"].lower()
        assert "httponly" in cookie
        assert "samesite=strict" in cookie
        assert "private-session-secret" not in bootstrap.text
        assert client.get("/api/projects").status_code == 200
        assert (
            client.get(
                "/bootstrap?token=one-time-launch-secret",
                follow_redirects=False,
            ).status_code
            == 401
        )


def test_packaged_mutations_require_exact_runtime_origin(
    tmp_path,
    monkeypatch,
) -> None:
    runtime_origin = "http://127.0.0.1:43123"
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOLOTRACE_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("SOLOTRACE_LAUNCH_SECRET", "one-time-launch-secret")
    monkeypatch.setenv("SOLOTRACE_SESSION_SECRET", "private-session-secret")
    monkeypatch.setattr("solotrace.api.PACKAGED", True)

    with TestClient(app, base_url=runtime_origin) as client:
        bootstrap = client.get(
            "/bootstrap?token=one-time-launch-secret",
            follow_redirects=False,
        )
        assert bootstrap.status_code == 303
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        mutation = {
            "expected_revision": project["revision"],
            "title": "Exact origin",
            "artist": project["artist"],
        }

        missing = client.patch(f"/api/projects/{DEMO_ID}", json=mutation)
        assert missing.status_code == 403

        cross_port = client.patch(
            f"/api/projects/{DEMO_ID}",
            json=mutation,
            headers={"Origin": "http://127.0.0.1:43124"},
        )
        assert cross_port.status_code == 403

        accepted = client.patch(
            f"/api/projects/{DEMO_ID}",
            json=mutation,
            headers={"Origin": runtime_origin},
        )
        assert accepted.status_code == 200
        assert accepted.json()["title"] == "Exact origin"


def test_keychain_api_receives_secret_without_shell_or_return_value(monkeypatch) -> None:
    saved: list[tuple[str, str, str]] = []
    deleted: list[tuple[str, str]] = []
    monkeypatch.setattr("solotrace.config.sys.platform", "darwin")
    monkeypatch.setattr(
        "solotrace.config.keyring.set_password",
        lambda service, account, secret: saved.append((service, account, secret)),
    )
    monkeypatch.setattr(
        "solotrace.config.keyring.delete_password",
        lambda service, account: deleted.append((service, account)),
    )

    store_mvsep_token("tester-owned-secret")
    delete_mvsep_token()

    assert saved == [(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, "tester-owned-secret")]
    assert deleted == [(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)]


def test_diagnostic_export_redacts_secrets_resources_and_project_metadata(
    tmp_path,
    monkeypatch,
) -> None:
    secret = "private-mvsep-token-123"
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOLOTRACE_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("SOLOTRACE_MVSEP_API_TOKEN", secret)

    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        logging.getLogger("solotrace.security-test").error(
            "api_token=%s GET /media/%s/original.wav source=%s",
            secret,
            DEMO_ID,
            "https://youtu.be/YE7VzlLtp-4?t=12",
        )
        response = client.get("/api/diagnostics/export")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        details = json.loads(archive.read("diagnostic.json"))
        log = archive.read("solotrace.log").decode()
    combined = json.dumps(details) + log
    assert details["storage"]["integrity"] == "ok"
    assert secret not in combined
    assert DEMO_ID not in combined
    assert "original.wav" not in combined
    assert project["title"] not in combined
    assert project["source_name"] not in combined
    assert "youtu.be" not in combined
    assert "YE7VzlLtp-4" not in combined
    assert "<redacted>" in log
    assert "<project-resource>" in log
    assert "<youtube-url>" in log
