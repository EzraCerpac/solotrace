from __future__ import annotations

from solotrace.fingering import assign_fingerings, legal_fingerings
from solotrace.models import Confidence, NoteEvent


def note(note_id: str, midi_pitch: int, onset: float) -> NoteEvent:
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
