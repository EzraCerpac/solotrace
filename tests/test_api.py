from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.demo import DEMO_ID
from solotrace.fingering import legal_fingerings
from solotrace.models import ProcessRequest, TabDocument


def test_health_and_demo_project_are_ready_without_accounts(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOLOTRACE_WORKER_DIR", str(tmp_path / "missing-workers"))
    monkeypatch.setenv("SOLOTRACE_MVSEP_API_TOKEN", "")
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["demo_project_id"] == DEMO_ID
        assert health.json()["separator"] == "preview"

        capabilities = client.get("/api/capabilities").json()
        assert capabilities["cloudReady"] is False
        assert capabilities["separation"]["available"]["mvsep"] is False
        assert capabilities["separation"]["mvsepMaxDurationS"] == 600
        assert "previewMaxDurationS" not in capabilities["separation"]

        response = client.get(f"/api/projects/{DEMO_ID}")
        assert response.status_code == 200
        project = response.json()
        assert project["run"]["state"] == "complete"
        assert project["demo"] is True
        assert len(project["tab"]["notes"]) >= 12
        summary = client.get("/api/projects").json()[0]
        assert "tab" not in summary
        assert summary["active_version_name"] == "Demo tab"

        media = client.get(f"/media/{DEMO_ID}/backing.wav", headers={"Range": "bytes=0-31"})
        assert media.status_code == 206
        assert len(media.content) == 32


def test_offline_process_range_has_no_draft_cap_but_mvsep_keeps_service_limit() -> None:
    offline = ProcessRequest(start_s=0, end_s=1_200, expected_revision=1)
    assert offline.end_s == 1_200

    with pytest.raises(ValueError, match="MVSep selections must be no longer than 10 minutes"):
        ProcessRequest(
            start_s=0,
            end_s=601,
            expected_revision=1,
            engine="mvsep",
            cloud_consent=True,
        )


def test_six_string_profile_uses_uncapoed_tuning_and_migrates_legacy_tabs() -> None:
    profile = ProcessRequest(
        start_s=0,
        end_s=10,
        expected_revision=1,
        tuning=[38, 45, 50, 55, 59, 64],
        capo_fret=2,
        fret_count=24,
        preferred_fret=7,
    )
    assert profile.tuning[0] == 38
    tab = TabDocument(
        sample_rate=44_100,
        tuning=profile.tuning,
        capo_fret=profile.capo_fret,
        fret_count=profile.fret_count,
        preferred_fret=profile.preferred_fret,
    )
    assert tab.sounding_tuning[0] == 40
    assert tab.available_fret_count == 22

    legacy = TabDocument.model_validate(
        {"sample_rate": 44_100, "tuning": [40, 45, 50, 55, 59, 64], "fret_count": 22}
    )
    assert legacy.capo_fret == 0
    assert legacy.preferred_fret is None


def test_mvsep_token_endpoint_stores_secret_without_returning_it(
    tmp_path,
    monkeypatch,
) -> None:
    worker_dir = tmp_path / "workers"
    basic_pitch = worker_dir / "transcribe" / "bin" / "python"
    basic_pitch.parent.mkdir(parents=True)
    basic_pitch.touch()
    stored: list[str] = []
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SOLOTRACE_WORKER_DIR", str(worker_dir))
    monkeypatch.setenv("SOLOTRACE_MVSEP_API_TOKEN", "configured-token-1234567890")
    monkeypatch.setattr("solotrace.api.store_mvsep_token", stored.append)

    with TestClient(app) as client:
        response = client.put(
            "/api/settings/mvsep-key",
            json={"api_token": "replacement-token-1234567890"},
        )

    assert response.status_code == 200
    assert response.json() == {"stored": True, "cloudReady": True}
    assert "replacement-token-1234567890" not in response.text
    assert stored == ["replacement-token-1234567890"]


def test_revision_conflict_protects_concurrent_note_edits(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        revision = project["revision"]
        payload = {
            "expected_revision": revision,
            "notes": project["tab"]["notes"],
        }
        first = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/notes",
            json=payload,
        )
        assert first.status_code == 200
        assert first.json()["revision"] == revision + 1

        stale = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/notes",
            json=payload,
        )
        assert stale.status_code == 409
        assert "current revision" in stale.json()["detail"]


def test_note_patch_normalizes_both_clocks_and_fingering(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        changed = project["tab"]["notes"][0] | {
            "audio_onset_s": 1.5,
            "audio_offset_s": 1.9,
            "midi_pitch": 70,
            "string": 1,
            "fret": 0,
        }
        response = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/notes",
            json={
                "expected_revision": project["revision"],
                "notes": [changed, *project["tab"]["notes"][1:]],
            },
        )
        assert response.status_code == 200
        normalized = response.json()["tab"]["notes"][0]
        assert normalized["onset_frame"] == round(1.5 * project["tab"]["sample_rate"])
        assert normalized["end_frame"] == round(1.9 * project["tab"]["sample_rate"])
        legal = legal_fingerings(
            70,
            project["tab"]["tuning"],
            project["tab"]["fret_count"],
        )
        assert (normalized["string"], normalized["fret"]) in {
            (fingering.string, fingering.fret) for fingering in legal
        }
        assert normalized["duration_ticks"] > 0


def test_non_finite_patch_is_rejected_without_corrupting_project(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        project["tab"]["notes"][0]["pitch_curve_cents"] = [float("nan")]
        response = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/notes",
            content=json.dumps(
                {
                    "expected_revision": project["revision"],
                    "notes": project["tab"]["notes"],
                }
            ),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422
        readable = client.get(f"/api/projects/{DEMO_ID}")
        assert readable.status_code == 200
        assert readable.json()["revision"] == project["revision"]


def test_local_origin_guard_and_reserved_api_routes(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        blocked = client.post(
            f"/api/projects/{DEMO_ID}/refinger",
            json={
                "expected_revision": project["revision"],
                "mode": "balanced",
            },
            headers={"Origin": "https://attacker.example"},
        )
        assert blocked.status_code == 403
        missing = client.get("/api/definitely-not-a-route")
        assert missing.status_code == 404
        assert missing.headers["content-type"].startswith("application/json")

        undeclared = client.get(f"/media/{DEMO_ID}/old-preview.wav")
        assert undeclared.status_code == 404


def test_request_models_reject_unknown_fields(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        response = client.post(
            f"/api/projects/{DEMO_ID}/refinger",
            json={
                "expected_revision": project["revision"],
                "mode": "balanced",
                "mdoe": "easiest",
            },
        )
        assert response.status_code == 422
