from __future__ import annotations

import pytest
from solotrace.fingering import FingeringConstraints
from solotrace.models import Confidence, NoteEvent, TabDocument
from solotrace.phrase import PhrasePlanError, plan_phrase_fingering


def note(note_id: str, midi_pitch: int, score_tick: int, **updates: object) -> NoteEvent:
    event = NoteEvent(
        id=note_id,
        onset_frame=score_tick * 10,
        end_frame=score_tick * 10 + 100,
        audio_onset_s=score_tick / 480,
        audio_offset_s=score_tick / 480 + 0.2,
        score_tick=score_tick,
        duration_ticks=192,
        midi_pitch=midi_pitch,
        string=1,
        fret=midi_pitch - 64,
        confidence=Confidence(pitch=0.9, onset=0.9, fingering=0.5, technique=0.8),
        reviewed=True,
    )
    return event.model_copy(update=updates)


def tab(notes: list[NoteEvent], **updates: object) -> TabDocument:
    document = TabDocument(sample_rate=44_100, notes=notes)
    return document.model_copy(update=updates)


def test_phrase_plan_preserves_boundaries_locks_and_unrestricted_alternatives() -> None:
    source_notes = [
        note("before", 64, 0, string=2, fret=5, user_locked=True),
        note("hammer", 67, 1920, techniques=["hammer-on"]),
        note("middle", 69, 2400),
        note(
            "after",
            65,
            3840,
            string=2,
            fret=6,
            user_locked=True,
        ),
    ]
    source = tab(source_notes)
    plan = plan_phrase_fingering(
        source,
        start_score_tick=2000,
        end_score_tick=2500,
        mode="position",
        constraints=FingeringConstraints(
            allowed_strings=frozenset({2}),
            min_fret=5,
            max_fret=12,
        ),
    )

    assert plan.range.start_score_tick == 1920
    assert plan.range.end_score_tick == 3840
    assert plan.selected_note_count == 2
    assert [(plan.notes[index].string, plan.notes[index].fret) for index in range(4)] == [
        (2, 5),
        (2, 8),
        (2, 10),
        (2, 6),
    ]
    assert not plan.notes[1].reviewed
    assert not plan.notes[1].user_locked
    assert any(candidate.string != 2 for candidate in plan.notes[2].alternatives)
    assert source.notes == source_notes


def test_phrase_constraints_keep_locked_notes_and_return_structured_errors() -> None:
    locked = note("locked", 69, 1920, string=1, fret=5, user_locked=True)
    plan = plan_phrase_fingering(
        tab([locked]),
        start_score_tick=1920,
        end_score_tick=3840,
        mode="easiest",
        constraints=FingeringConstraints(
            allowed_strings=frozenset({2}),
            min_fret=8,
            max_fret=12,
        ),
    )
    assert (plan.notes[0].string, plan.notes[0].fret) == (1, 5)
    assert plan.locked_note_count == 1
    assert plan.changes == []

    with pytest.raises(PhrasePlanError) as empty:
        plan_phrase_fingering(
            tab([]),
            start_score_tick=0,
            end_score_tick=100,
            mode="balanced",
        )
    assert empty.value.code == "empty-range"

    with pytest.raises(PhrasePlanError) as invalid:
        plan_phrase_fingering(
            tab([locked]),
            start_score_tick=1920,
            end_score_tick=3840,
            mode="balanced",
            constraints=FingeringConstraints(allowed_strings=frozenset()),
        )
    assert invalid.value.code == "invalid-constraints"


def test_phrase_plan_uses_sounding_tuning_with_capo() -> None:
    source = tab([note("capo-note", 66, 0, string=1, fret=0)], capo_fret=2)
    plan = plan_phrase_fingering(
        source,
        start_score_tick=0,
        end_score_tick=100,
        mode="easiest",
        constraints=FingeringConstraints(
            allowed_strings=frozenset({1}),
            min_fret=0,
            max_fret=0,
        ),
    )
    assert (plan.notes[0].string, plan.notes[0].fret) == (1, 0)
