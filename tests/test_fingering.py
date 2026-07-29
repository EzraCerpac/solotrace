from __future__ import annotations

import json
from pathlib import Path

import pytest
from solotrace.fingering import (
    assign_fingerings,
    legal_fingerings,
    validate_connected_technique_fingerings,
)
from solotrace.models import Confidence, NoteEvent


def note(
    note_id: str,
    midi_pitch: int,
    onset: float,
    techniques: list[str] | None = None,
) -> NoteEvent:
    return NoteEvent(
        id=note_id,
        onset_frame=round(onset * 44_100),
        end_frame=round((onset + 0.4) * 44_100),
        audio_onset_s=onset,
        audio_offset_s=onset + 0.4,
        score_tick=round(onset * 480),
        duration_ticks=192,
        midi_pitch=midi_pitch,
        string=1,
        fret=0,
        techniques=techniques or [],
        confidence=Confidence(pitch=0.9, onset=0.9, fingering=0.5, technique=0.8),
    )


def test_legal_fingerings_use_standard_guitar_string_numbers() -> None:
    positions = legal_fingerings(64, [40, 45, 50, 55, 59, 64], 22)
    assert {(position.string, position.fret) for position in positions} == {
        (1, 0),
        (2, 5),
        (3, 9),
        (4, 14),
        (5, 19),
    }


def test_position_mode_keeps_a_phrase_compact() -> None:
    phrase = [
        note("a", 64, 0),
        note("b", 67, 0.5),
        note("c", 69, 1.0),
        note("d", 71, 1.5),
    ]
    arranged = assign_fingerings(
        phrase,
        [40, 45, 50, 55, 59, 64],
        22,
        mode="position",
    )
    frets = [event.fret for event in arranged]
    assert max(frets) - min(frets) <= 7
    assert all(event.alternatives for event in arranged)
    assert all(0 <= event.confidence.fingering <= 1 for event in arranged)


def test_out_of_range_pitch_has_actionable_error() -> None:
    phrase = [note("too-low", 30, 0)]
    try:
        assign_fingerings(phrase, [40, 45, 50, 55, 59, 64], 22)
    except ValueError as error:
        assert "MIDI pitch 30" in str(error)
    else:
        raise AssertionError("out-of-range pitch should fail")


def test_user_locked_fingering_survives_global_refinger() -> None:
    locked = note("locked", 69, 0).model_copy(
        update={
            "string": 2,
            "fret": 10,
            "user_locked": True,
        }
    )

    arranged = assign_fingerings(
        [locked],
        [40, 45, 50, 55, 59, 64],
        22,
        mode="easiest",
    )

    assert (arranged[0].string, arranged[0].fret) == (2, 10)


def test_simultaneous_double_stop_uses_distinct_strings_in_every_mode() -> None:
    phrase = [note("lower", 64, 0), note("upper", 67, 0)]

    for mode in ("balanced", "easiest", "position"):
        first = assign_fingerings(
            phrase,
            [40, 45, 50, 55, 59, 64],
            22,
            mode=mode,
        )
        second = assign_fingerings(
            phrase,
            [40, 45, 50, 55, 59, 64],
            22,
            mode=mode,
        )

        assert first == second
        assert first[0].string != first[1].string
        assert all(
            alternative.string != first[1 - index].string
            for index, event in enumerate(first)
            for alternative in event.alternatives
        )


def test_simultaneous_voicing_preserves_locks_and_connected_techniques() -> None:
    previous = note("previous", 64, 0).model_copy(
        update={"string": 2, "fret": 5, "user_locked": True}
    )
    connected = note("connected", 67, 0.5, ["hammer-on"])
    sibling = note("sibling", 72, 0.5)

    arranged = assign_fingerings(
        [previous, connected, sibling],
        [40, 45, 50, 55, 59, 64],
        22,
    )

    validate_connected_technique_fingerings(arranged)
    assert (arranged[0].string, arranged[0].fret) == (2, 5)
    assert (arranged[1].string, arranged[1].fret) == (2, 8)
    assert arranged[2].string != arranged[1].string


def test_conflicting_simultaneous_locks_fail_actionably() -> None:
    lower = note("lower", 64, 0).model_copy(
        update={"string": 1, "fret": 0, "user_locked": True}
    )
    upper = note("upper", 67, 0).model_copy(
        update={"string": 1, "fret": 3, "user_locked": True}
    )

    with pytest.raises(
        ValueError,
        match=r"Simultaneous notes lower, upper.*distinct strings",
    ):
        assign_fingerings(
            [lower, upper],
            [40, 45, 50, 55, 59, 64],
            22,
        )

    connected_sibling = note("connected-sibling", 67, 0, ["hammer-on"])
    with pytest.raises(
        ValueError,
        match=r"Simultaneous notes lower, connected-sibling.*distinct strings",
    ):
        assign_fingerings(
            [note("lower", 64, 0), connected_sibling],
            [40, 45, 50, 55, 59, 64],
            22,
        )


def test_unsorted_notes_are_arranged_chronologically_and_returned_in_input_order() -> None:
    phrase = [
        note("early-40", 40, 0),
        note("later-40", 40, 1, ["pull-off"]),
        note("early-41", 41, 0),
    ]
    original = [event.model_copy(deep=True) for event in phrase]

    arranged = assign_fingerings(phrase, [35, 40, 45, 50], 22)

    assert phrase == original
    assert [event.id for event in arranged] == [
        "early-40",
        "later-40",
        "early-41",
    ]
    assert arranged[0].string != arranged[2].string
    assert arranged[1].string == arranged[2].string
    assert arranged[1].fret < arranged[2].fret
    validate_connected_technique_fingerings(arranged)


def test_eight_string_unison_uses_bounded_distinct_string_states() -> None:
    phrase = [note(f"voice-{index}", 64, 0) for index in range(8)]
    tuning = [28, 33, 38, 43, 48, 53, 58, 63]

    first = assign_fingerings(phrase, tuning, 36)
    second = assign_fingerings(phrase, tuning, 36)

    assert first == second
    assert {event.string for event in first} == set(range(1, 9))
    assert [event.id for event in first] == [event.id for event in phrase]


def test_connected_techniques_constrain_path_and_alternatives() -> None:
    arranged = assign_fingerings(
        [
            note("picked", 64, 0),
            note("hammer", 67, 0.5, ["hammer-on"]),
            note("pull", 65, 1.0, ["pull-off"]),
            note("slide", 69, 1.5, ["slide"]),
        ],
        [40, 45, 50, 55, 59, 64],
        22,
    )

    validate_connected_technique_fingerings(arranged)
    assert len({event.string for event in arranged}) == 1
    assert arranged[1].fret > arranged[0].fret
    assert arranged[2].fret < arranged[1].fret
    assert arranged[3].fret != arranged[2].fret
    for event in arranged:
        assert event.alternatives
        assert {alternative.string for alternative in event.alternatives} == {event.string}


def test_invalid_connected_technique_has_actionable_error() -> None:
    with pytest.raises(ValueError, match="cannot start with hammer-on"):
        assign_fingerings(
            [note("first", 67, 0, ["hammer-on"])],
            [40, 45, 50, 55, 59, 64],
            22,
        )
    previous = note("previous", 64, 0).model_copy(
        update={"string": 1, "fret": 0, "user_locked": True}
    )
    destination = note("destination", 67, 0.5, ["hammer-on"]).model_copy(
        update={"string": 2, "fret": 8, "user_locked": True}
    )
    with pytest.raises(ValueError, match="no playable connection"):
        assign_fingerings(
            [previous, destination],
            [40, 45, 50, 55, 59, 64],
            22,
        )


def test_python_matches_shared_fingering_parity_fixture() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "fingering-parity.json").read_text()
    )
    phrase = [
        note(f"parity-{index}", pitch, index * 0.25)
        for index, pitch in enumerate(fixture["pitches"])
    ]
    for mode, expected in fixture["expected"].items():
        arranged = assign_fingerings(
            phrase,
            fixture["tuning"],
            fixture["fret_count"],
            mode,
        )
        assert [[event.string, event.fret] for event in arranged] == expected

    simultaneous = fixture["simultaneous"]
    phrase = [
        note(f"simultaneous-{index}", pitch, 0)
        for index, pitch in enumerate(simultaneous["pitches"])
    ]
    for mode, expected in simultaneous["expected"].items():
        arranged = assign_fingerings(
            phrase,
            fixture["tuning"],
            fixture["fret_count"],
            mode,
        )
        assert [[event.string, event.fret] for event in arranged] == expected
