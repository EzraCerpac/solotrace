from __future__ import annotations

from xml.etree import ElementTree as ET

import numpy as np
import pytest
from fastapi.testclient import TestClient

from solotrace.api import app
from solotrace.chords import (
    CONFIG_SHA256,
    MODEL_REVISION,
    MODEL_SHA256,
    _session,
    model_config,
    normalize_edited_chords,
    recognition_capability,
)
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.exports import musicxml
from solotrace.models import ChordEvent, ChordTrack, SpelledPitch
from solotrace.storage import ProjectStore


def _event(
    event_id: str,
    start_s: float,
    end_s: float,
    *,
    kind: str = "chord",
) -> ChordEvent:
    chord = kind == "chord"
    return ChordEvent(
        id=event_id,
        onset_frame=1,
        end_frame=2,
        audio_onset_s=start_s,
        audio_offset_s=end_s,
        score_tick=0,
        duration_ticks=1,
        kind=kind,
        root=SpelledPitch(step="D", alter=-1) if chord else None,
        quality="min7" if chord else None,
        provenance="manual",
        edited=True,
    )


def test_pinned_chordmini_configuration_and_zero_input_parity() -> None:
    capability = recognition_capability()
    config = model_config()
    assert capability == {
        "available": True,
        "engine": "ChordMini 2E1D ONNX",
        "modelRevision": MODEL_REVISION,
        "modelSha256": MODEL_SHA256,
        "detail": "Pinned model verified for offline recognition",
        "desktopOnly": True,
    }
    assert CONFIG_SHA256 == "1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4"
    assert len(config["chordVocab"]) == 170
    assert config["chordVocab"][-2:] == ["X", "N"]

    features = np.zeros((1, 108, 144), dtype=np.float32)
    logits = _session().run(["logits"], {"features": features})[0]
    assert logits.shape == (1, 108, 170)
    assert np.argmax(logits, axis=-1).tolist() == [[169] * 108]
    np.testing.assert_allclose(
        logits[0, 0, [0, 1, 168, 169]],
        [1.460913, 2.695624, -4.660178, 3.893088],
        rtol=0,
        atol=1e-5,
    )


def test_chord_normalization_rebuilds_dual_clock_and_requires_contiguous_spans(
    tmp_path,
) -> None:
    project = ensure_demo(ProjectStore(tmp_path))
    start = project.passage.start_s
    middle = 8.25
    end = project.passage.end_s
    submitted = ChordTrack(
        engine="manual",
        analyzed_start_s=start,
        analyzed_end_s=end,
        events=[
            _event("left", start, middle),
            _event("right", middle, end, kind="no-chord"),
        ],
    )
    normalized = normalize_edited_chords(project, submitted)
    assert normalized.events[0].onset_frame == round(start * project.tab.sample_rate)
    assert normalized.events[0].end_frame == normalized.events[1].onset_frame
    assert normalized.events[0].duration_ticks > 1
    assert normalized.events[1].kind == "no-chord"
    assert normalized.events[1].root is None

    broken = submitted.model_copy(
        update={
            "events": [
                submitted.events[0].model_copy(update={"audio_offset_s": middle - 0.1}),
                submitted.events[1],
            ]
        }
    )
    with pytest.raises(ValueError, match="contiguous"):
        normalize_edited_chords(project, broken)


def test_musicxml_exports_timed_harmony_with_spelling_and_no_chord(tmp_path) -> None:
    project = ensure_demo(ProjectStore(tmp_path))
    root = ET.fromstring(musicxml(project))
    harmonies = root.findall("./part/measure/harmony")
    assert len(harmonies) == len(project.tab.chords.events)
    assert harmonies[0].findtext("./root/root-step") == project.tab.chords.events[0].root.step
    assert harmonies[0].findtext("./kind") == "major"

    start = project.passage.start_s
    end = project.passage.end_s
    track = ChordTrack(
        engine="manual",
        analyzed_start_s=start,
        analyzed_end_s=end,
        events=[_event("nc", start, end, kind="no-chord")],
    )
    edited = project.replace_active_tab(project.tab.model_copy(update={"chords": track}))
    no_chord = ET.fromstring(musicxml(edited)).find("./part/measure/harmony/kind")
    assert no_chord is not None
    assert no_chord.text == "none"
    assert no_chord.attrib["text"] == "N.C."


def test_chord_patch_is_revision_protected_and_keeps_notes(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path))
    with TestClient(app) as client:
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        original_notes = project["tab"]["notes"]
        track = project["tab"]["chords"]
        first = track["events"][0]
        first["root"] = {"step": "D", "alter": -1}
        first["quality"] = "min7"
        first["edited"] = True
        response = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/chords",
            json={"expected_revision": project["revision"], "track": track},
        )
        assert response.status_code == 200
        changed = response.json()
        assert changed["tab"]["notes"] == original_notes
        assert changed["tab"]["chords"]["events"][0]["root"] == {
            "step": "D",
            "alter": -1,
        }

        stale = client.patch(
            f"/api/projects/{DEMO_ID}/versions/{project['active_version_id']}/chords",
            json={"expected_revision": project["revision"], "track": track},
        )
        assert stale.status_code == 409
