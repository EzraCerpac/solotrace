from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree as ET

import mido
import pytest
from solotrace.demo import DEMO_ID, ensure_demo
from solotrace.exports import ascii_tab, bundle, export_filename, midi, musicxml
from solotrace.models import ChordTrack
from solotrace.storage import ProjectStore


def test_demo_has_aligned_exact_stems_and_editable_notes(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)

    assert project.id == DEMO_ID
    assert project.separation_scope == "exact"
    assert {asset.role for asset in project.assets} == {"original", "lead", "backing"}
    assert len(project.tab.notes) >= 12
    assert project.tab.sync_anchors
    assert any("bend" in note.techniques for note in project.tab.notes)
    assert any(note.confidence.minimum < 0.7 for note in project.tab.notes)

    for asset in project.assets:
        assert (store.project_dir(project.id) / asset.filename).stat().st_size > 1_000


def test_exports_are_parseable_and_native_bundle_keeps_audio(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    directory = store.project_dir(project.id)

    root = ET.fromstring(musicxml(project))
    assert root.tag == "score-partwise"
    assert root.findtext("./work/work-title") == project.title

    midi_file = mido.MidiFile(file=io.BytesIO(midi(project)))
    assert any(message.type == "note_on" for message in midi_file.tracks[0])

    with zipfile.ZipFile(io.BytesIO(bundle(project, directory))) as archive:
        names = set(archive.namelist())
    assert f"{project.id}/project.json" in names
    assert f"{project.id}/versions/{project.active_version_id}/tab.musicxml" in names
    assert f"{project.id}/audio/backing.wav" in names


def test_musicxml_respects_denominator_tempo_and_splits_cross_measure_note(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    crossing_note = project.tab.notes[0].model_copy(
        update={
            "score_tick": 1_300,
            "duration_ticks": 3_000,
        }
    )
    tab = project.tab.model_copy(
        update={
            "tempo_bpm": 137.5,
            "time_signature": (6, 8),
            "notes": [crossing_note],
            "chords": ChordTrack(),
        }
    )
    project = project.replace_active_tab(tab)

    root = ET.fromstring(musicxml(project))
    measures = root.findall("./part/measure")

    assert len(measures) == 3
    assert measures[0].findtext("./direction/direction-type/metronome/beat-unit") == "quarter"
    assert measures[0].findtext("./direction/direction-type/metronome/per-minute") == "137.5"
    assert measures[0].find("./direction/sound").attrib["tempo"] == "137.5"

    # Six eighth-notes at 480 ticks per quarter occupy 1,440 ticks, not 2,880.
    measure_durations = [
        sum(int(node.text) for node in measure.findall("./forward/duration"))
        + sum(int(node.text) for node in measure.findall("./note/duration"))
        for measure in measures
    ]
    assert measure_durations == [1_440, 1_440, 1_420]

    notes = [measure.find("./note") for measure in measures]
    assert [[tie.attrib["type"] for tie in note.findall("./tie")] for note in notes] == [
        ["start"],
        ["stop", "start"],
        ["stop"],
    ]
    assert [
        [tie.attrib["type"] for tie in note.findall("./notations/tied")] for note in notes
    ] == [["start"], ["stop", "start"], ["stop"]]


def test_bundle_fails_if_a_declared_asset_is_missing(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    directory = store.project_dir(project.id)
    missing_asset = project.asset("backing")
    assert missing_asset is not None
    (directory / missing_asset.filename).unlink()

    with pytest.raises(FileNotFoundError, match=r"declared backing asset is missing"):
        bundle(project, directory)


def test_bundle_stays_reimportable_when_musicxml_cannot_represent_notes(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    first, second = project.tab.notes[:2]
    overlapping = second.model_copy(
        update={
            "score_tick": first.score_tick,
            "duration_ticks": first.duration_ticks,
        }
    )
    project = project.replace_active_tab(
        project.tab.model_copy(update={"notes": [first, overlapping]})
    )

    with zipfile.ZipFile(io.BytesIO(bundle(project, store.project_dir(project.id)))) as archive:
        names = set(archive.namelist())
    version_root = f"{project.id}/versions/{project.active_version_id}"
    assert f"{project.id}/project.json" in names
    assert f"{version_root}/tab.musicxml" not in names
    assert f"{version_root}/reference.mid" in names
    assert f"{project.id}/audio/original.wav" in names


def test_unicode_title_has_portable_midi_metadata_and_filename(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store).model_copy(update={"title": "中文 🎸"})

    parsed = mido.MidiFile(file=io.BytesIO(midi(project)))

    assert parsed.tracks[0][0].type == "track_name"
    assert export_filename(project, "midi") == f"{project.id}.mid"


def test_text_tab_keeps_colliding_tokens_and_bend_range(tmp_path) -> None:
    store = ProjectStore(tmp_path)
    project = ensure_demo(store)
    first = project.tab.notes[0].model_copy(
        update={
            "audio_onset_s": 2,
            "string": 1,
            "fret": 10,
            "techniques": ["bend"],
            "pitch_curve_cents": [-50, 50],
        }
    )
    second = project.tab.notes[1].model_copy(
        update={
            "audio_onset_s": 2,
            "string": 1,
            "fret": 12,
        }
    )
    project = project.replace_active_tab(
        project.tab.model_copy(update={"notes": [first, second]})
    )

    text = ascii_tab(project, width=24)
    root = ET.fromstring(musicxml(project))

    assert "10b12" in text
    assert root.findtext(".//bend/bend-alter") == "1.0"
