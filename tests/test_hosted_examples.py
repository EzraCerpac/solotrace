from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest
from solotrace.demo import EXAMPLE_SPECS, SAMPLE_RATE, write_hosted_examples
from solotrace.fingering import validate_connected_technique_fingerings
from solotrace.models import Project

HOSTED_PROJECT_KEYS = {
    "id",
    "title",
    "artist",
    "created_at",
    "updated_at",
    "revision",
    "duration_s",
    "passage",
    "assets",
    "versions",
    "active_version_id",
    "source_name",
    "origin",
    "example_slug",
    "waveform_peaks",
    "provenance",
    "separation_scope",
}


@pytest.fixture(scope="module")
def generated_examples(tmp_path_factory: pytest.TempPathFactory) -> Path:
    output = tmp_path_factory.mktemp("hosted-examples")
    write_hosted_examples(output)
    return output


def _load_project(output: Path, slug: str) -> Project:
    document = json.loads((output / slug / "project.json").read_text(encoding="utf-8"))
    assert set(document) == HOSTED_PROJECT_KEYS
    assert {"run", "demo", "trashed_at"}.isdisjoint(document)
    assert document.pop("origin") == "example"
    assert document.pop("example_slug") == slug
    document["run"] = {
        "id": f"{slug}-schema-validation",
        "state": "complete",
        "stages": [],
        "created_at": document["created_at"],
        "updated_at": document["updated_at"],
    }
    return Project.model_validate(document)


@pytest.mark.parametrize("spec", EXAMPLE_SPECS, ids=lambda spec: spec.slug)
def test_hosted_example_schema_timing_and_fingerings(generated_examples: Path, spec) -> None:
    project = _load_project(generated_examples, spec.slug)

    assert project.title == spec.title
    assert project.duration_s == spec.duration_s
    assert project.separation_scope == "exact"
    assert project.tab.tempo_bpm == spec.tempo_bpm
    assert project.tab.time_signature == spec.time_signature
    assert project.tab.tuning == list(spec.tuning)
    assert project.tab.notes
    assert len({note.id for note in project.tab.notes}) == len(project.tab.notes)

    anchor_pairs = [(anchor.audio_frame, anchor.score_tick) for anchor in project.tab.sync_anchors]
    assert anchor_pairs == sorted(anchor_pairs)
    assert all(
        left[0] < right[0] and left[1] < right[1]
        for left, right in zip(anchor_pairs, anchor_pairs[1:], strict=False)
    )
    assert anchor_pairs[-1][0] == round(project.duration_s * SAMPLE_RATE)

    for version in project.versions:
        validate_connected_technique_fingerings(version.tab.notes)
        for note in version.tab.notes:
            open_pitch = version.tab.tuning[len(version.tab.tuning) - note.string]
            assert open_pitch + note.fret == note.midi_pitch
            assert 0 <= note.fret <= version.tab.fret_count
            assert note.onset_frame < note.end_frame <= round(project.duration_s * SAMPLE_RATE)


@pytest.mark.parametrize("spec", EXAMPLE_SPECS, ids=lambda spec: spec.slug)
def test_connected_techniques_match_fingering_and_rendered_pitch_curve(
    generated_examples: Path,
    spec,
) -> None:
    project = _load_project(generated_examples, spec.slug)
    for version in project.versions:
        for index, note in enumerate(version.tab.notes):
            connected = set(note.techniques) & {
                "hammer-on",
                "pull-off",
                "slide",
                "slide-up",
                "slide-down",
            }
            if not connected:
                continue
            previous = version.tab.notes[index - 1]
            assert note.string == previous.string
            if "hammer-on" in connected:
                assert note.fret > previous.fret
            elif "pull-off" in connected:
                assert note.fret < previous.fret
            else:
                assert note.fret != previous.fret

            for alternative in note.alternatives:
                assert alternative.string == previous.string
                if "hammer-on" in connected:
                    assert alternative.fret > previous.fret
                elif "pull-off" in connected:
                    assert alternative.fret < previous.fret
                else:
                    assert alternative.fret != previous.fret

    for index, (note_spec, rendered_note) in enumerate(
        zip(spec.notes, project.tab.notes, strict=True)
    ):
        if not set(note_spec.techniques) & {"slide", "slide-up", "slide-down"}:
            continue
        expected_start_cents = (spec.notes[index - 1].midi - note_spec.midi) * 100
        assert rendered_note.pitch_curve_cents[0] == pytest.approx(expected_start_cents)
        assert rendered_note.pitch_curve_cents[-1] == pytest.approx(0, abs=0.1)


@pytest.mark.parametrize("spec", EXAMPLE_SPECS, ids=lambda spec: spec.slug)
def test_hosted_example_stems_are_aligned_and_decompose_exactly(
    generated_examples: Path,
    spec,
) -> None:
    decoded: dict[str, np.ndarray] = {}
    parameters = set()
    for role in ("original", "lead", "backing"):
        with wave.open(str(generated_examples / spec.slug / f"{role}.wav"), "rb") as source:
            parameters.add(
                (
                    source.getnchannels(),
                    source.getsampwidth(),
                    source.getframerate(),
                    source.getnframes(),
                )
            )
            decoded[role] = np.frombuffer(
                source.readframes(source.getnframes()), dtype="<i2"
            ).astype(np.int32)

    assert parameters == {(2, 2, SAMPLE_RATE, round(spec.duration_s * SAMPLE_RATE))}
    np.testing.assert_array_equal(decoded["original"], decoded["lead"] + decoded["backing"])


def test_hosted_catalog_and_examples_cover_the_studio_story(generated_examples: Path) -> None:
    catalog = json.loads((generated_examples / "catalog.json").read_text(encoding="utf-8"))
    by_slug = {entry["slug"]: entry for entry in catalog}
    assert set(by_slug) == {spec.slug for spec in EXAMPLE_SPECS}
    assert all(entry["license"] == "CC0-1.0" for entry in catalog)
    assert all("CC0 1.0" in " ".join(entry["provenance"]) for entry in catalog)

    northbound = _load_project(generated_examples, "northbound-lights")
    northbound_techniques = {
        technique for note in northbound.tab.notes for technique in note.techniques
    }
    assert {"bend", "vibrato"} <= northbound_techniques
    assert any(note.confidence.minimum < 0.7 for note in northbound.tab.notes)

    switchback = _load_project(generated_examples, "switchback-run")
    switchback_techniques = {
        technique for note in switchback.tab.notes for technique in note.techniques
    }
    assert {"hammer-on", "pull-off", "slide"} <= switchback_techniques

    low_orbit = _load_project(generated_examples, "low-orbit")
    assert low_orbit.tab.time_signature == (6, 8)
    assert low_orbit.tab.tuning[0] == 38
    assert [(version.name, version.fingering_mode) for version in low_orbit.versions] == [
        ("Balanced", "balanced"),
        ("Easiest", "easiest"),
        ("One Position", "position"),
    ]
    fingering_paths = {
        tuple((note.string, note.fret) for note in version.tab.notes)
        for version in low_orbit.versions
    }
    assert len(fingering_paths) == 3


def test_note_and_version_ids_are_unique_across_the_catalog(generated_examples: Path) -> None:
    note_ids: list[str] = []
    version_ids: list[str] = []
    for spec in EXAMPLE_SPECS:
        project = _load_project(generated_examples, spec.slug)
        note_ids.extend(note.id for note in project.tab.notes)
        version_ids.extend(version.id for version in project.versions)
    assert len(note_ids) == len(set(note_ids))
    assert len(version_ids) == len(set(version_ids))
