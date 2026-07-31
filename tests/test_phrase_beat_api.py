from __future__ import annotations

from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.demo import DEMO_ID


def test_phrase_version_is_mixed_and_keeps_source_outside_selected_bars(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        source = client.get(f"/api/projects/{DEMO_ID}").json()
        source_id = source["active_version_id"]
        selected = source["tab"]["notes"][0]
        bar_ticks = (
            source["tab"]["ticks_per_quarter"]
            * 4
            * source["tab"]["time_signature"][0]
            // source["tab"]["time_signature"][1]
        )
        bar_start = selected["score_tick"] // bar_ticks * bar_ticks
        bar_end = bar_start + bar_ticks

        response = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": source["revision"],
                "source_version_id": source_id,
                "name": "Opening phrase",
                "mode": "position",
                "range": {
                    "start_score_tick": selected["score_tick"],
                    "end_score_tick": selected["score_tick"] + 1,
                },
                "constraints": {"min_fret": 0, "max_fret": 22},
            },
        )

        assert response.status_code == 200
        changed = response.json()
        assert changed["revision"] == source["revision"] + 1
        assert changed["active_version_id"] != source_id
        assert changed["versions"][-1]["fingering_mode"] == "mixed"
        assert changed["versions"][-1]["name"] == "Opening phrase"
        source_notes = {note["id"]: note for note in source["tab"]["notes"]}
        for note in changed["tab"]["notes"]:
            previous = source_notes[note["id"]]
            if not bar_start <= note["score_tick"] < bar_end:
                assert note == previous

        stale = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": source["revision"],
                "source_version_id": source_id,
                "mode": "easiest",
                "range": {"start_score_tick": bar_start, "end_score_tick": bar_end},
            },
        )
        assert stale.status_code == 409


def test_beat_map_patch_is_atomic_active_only_and_conflict_protected(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        source = client.get(f"/api/projects/{DEMO_ID}").json()
        source_id = source["active_version_id"]
        duplicated = client.post(
            f"/api/projects/{DEMO_ID}/versions",
            json={
                "expected_revision": source["revision"],
                "source_version_id": source_id,
                "name": "Timing pass",
                "mode": None,
            },
        ).json()
        target_id = duplicated["active_version_id"]
        sample_rate = duplicated["tab"]["sample_rate"]
        events = [
            *duplicated["tab"]["notes"],
            *duplicated["tab"]["chords"]["events"],
        ]
        start_frame = min(event["onset_frame"] for event in events)
        end_frame = max(event["end_frame"] for event in events)
        ticks_per_quarter = duplicated["tab"]["ticks_per_quarter"]
        end_tick = round((end_frame - start_frame) * ticks_per_quarter * 120 / sample_rate / 60)
        beat_map = {
            "tempo_bpm": 120,
            "time_signature": [4, 4],
            "bar_offset_ticks": 480,
            "sync_anchors": [
                {"audio_frame": start_frame, "score_tick": 0},
                {"audio_frame": end_frame, "score_tick": end_tick},
            ],
        }
        before_audio = [
            (note["id"], note["onset_frame"], note["end_frame"], note["audio_onset_s"])
            for note in duplicated["tab"]["notes"]
        ]

        response = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{target_id}/beat-map",
            json={"expected_revision": duplicated["revision"], "beat_map": beat_map},
        )
        assert response.status_code == 200
        changed = response.json()
        assert changed["revision"] == duplicated["revision"] + 1
        assert changed["tab"]["bar_offset_ticks"] == 480
        assert changed["tab"]["sync_anchors"] == beat_map["sync_anchors"]
        assert [
            (note["id"], note["onset_frame"], note["end_frame"], note["audio_onset_s"])
            for note in changed["tab"]["notes"]
        ] == before_audio

        stale = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{target_id}/beat-map",
            json={"expected_revision": duplicated["revision"], "beat_map": beat_map},
        )
        assert stale.status_code == 409

        uncovered = {
            **beat_map,
            "sync_anchors": [
                {"audio_frame": start_frame + 1, "score_tick": 0},
                beat_map["sync_anchors"][1],
            ],
        }
        rejected = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{target_id}/beat-map",
            json={"expected_revision": changed["revision"], "beat_map": uncovered},
        )
        assert rejected.status_code == 422

        source_again = client.post(
            f"/api/projects/{DEMO_ID}/versions/{source_id}/activate",
            json={"expected_revision": changed["revision"]},
        )
        assert source_again.status_code == 200
        assert source_again.json()["tab"] == source["tab"]
