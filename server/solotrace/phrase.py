from __future__ import annotations

import math
from dataclasses import dataclass

from .fingering import FingeringConstraints, FingeringMode, assign_fingerings
from .models import NoteEvent, TabDocument


class PhrasePlanError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PhraseScoreRange:
    start_score_tick: int
    end_score_tick: int


@dataclass(frozen=True)
class PhraseFingeringChange:
    note_id: str
    score_tick: int
    midi_pitch: int
    before_string: int
    before_fret: int
    after_string: int
    after_fret: int


@dataclass(frozen=True)
class PhraseFingeringPlan:
    range: PhraseScoreRange
    mode: FingeringMode
    constraints: FingeringConstraints
    notes: list[NoteEvent]
    changes: list[PhraseFingeringChange]
    selected_note_count: int
    locked_note_count: int


def _bar_ticks(tab: TabDocument) -> int:
    beats, beat_unit = tab.time_signature
    ticks = tab.ticks_per_quarter * 4 * beats / beat_unit
    if not ticks.is_integer() or ticks <= 0:
        raise PhrasePlanError(
            "invalid-range",
            "Time signature does not divide into whole score ticks.",
        )
    return int(ticks)


def _expanded_range(
    tab: TabDocument,
    start_score_tick: int,
    end_score_tick: int,
) -> PhraseScoreRange:
    if start_score_tick < 0 or end_score_tick <= start_score_tick:
        raise PhrasePlanError(
            "invalid-range",
            "Phrase range must have a non-negative start before its end.",
        )
    ticks_per_bar = _bar_ticks(tab)
    offset = getattr(tab, "bar_offset_ticks", 0)
    start = max(
        0,
        math.floor((start_score_tick - offset) / ticks_per_bar) * ticks_per_bar
        + offset,
    )
    end = (
        math.ceil((end_score_tick - offset) / ticks_per_bar) * ticks_per_bar
        + offset
    )
    return PhraseScoreRange(start_score_tick=start, end_score_tick=end)


def _validated_constraints(
    tab: TabDocument,
    constraints: FingeringConstraints | None,
) -> FingeringConstraints:
    candidate = constraints or FingeringConstraints()
    strings = candidate.allowed_strings
    if (
        (
            strings is not None
            and (not strings or any(s < 1 or s > len(tab.tuning) for s in strings))
        )
        or (candidate.min_fret is not None and candidate.min_fret < 0)
        or (candidate.max_fret is not None and candidate.max_fret > tab.available_fret_count)
        or (
            candidate.min_fret is not None
            and candidate.max_fret is not None
            and candidate.min_fret > candidate.max_fret
        )
    ):
        raise PhrasePlanError(
            "invalid-constraints",
            "Choose at least one valid string and a fret range available on this instrument.",
        )
    return candidate


def _group_indices(notes: list[NoteEvent], start: int, step: int) -> list[int]:
    if not 0 <= start < len(notes):
        return []
    onset = notes[start].onset_frame
    indices: list[int] = []
    index = start
    while 0 <= index < len(notes) and notes[index].onset_frame == onset:
        indices.append(index)
        index += step
    return indices


def plan_phrase_fingering(
    tab: TabDocument,
    *,
    start_score_tick: int,
    end_score_tick: int,
    mode: FingeringMode,
    constraints: FingeringConstraints | None = None,
) -> PhraseFingeringPlan:
    """Plan bar-aligned partial fingering without mutating the source tab."""
    range_ = _expanded_range(tab, start_score_tick, end_score_tick)
    normalized_constraints = _validated_constraints(tab, constraints)
    chronological = sorted(
        enumerate(tab.notes),
        key=lambda indexed: (indexed[1].onset_frame, indexed[0]),
    )
    arranged = [note for _, note in chronological]
    selected_indices = {
        index
        for index, note in enumerate(arranged)
        if range_.start_score_tick <= note.score_tick < range_.end_score_tick
    }
    if not selected_indices:
        raise PhrasePlanError(
            "empty-range",
            "Selected bars contain no notes. Choose bars containing tablature.",
        )

    first_index = min(selected_indices)
    last_index = max(selected_indices)
    context_indices = {
        *_group_indices(arranged, first_index - 1, -1),
        *_group_indices(arranged, last_index + 1, 1),
    }
    working_indices = sorted(selected_indices | context_indices)
    working_notes = [
        arranged[index].model_copy(update={"user_locked": True})
        if index in context_indices
        else arranged[index]
        for index in working_indices
    ]
    try:
        planned_working = assign_fingerings(
            working_notes,
            tab.sounding_tuning,
            tab.available_fret_count,
            mode,
            tab.preferred_fret,
            normalized_constraints,
        )
    except ValueError as error:
        raise PhrasePlanError(
            "impossible-constraints",
            f"No playable fingering fits these phrase controls. {error}",
        ) from error

    notes = [note.model_copy(deep=True) for note in tab.notes]
    for working_index, chronological_index in enumerate(working_indices):
        if chronological_index not in selected_indices:
            continue
        original_index = chronological[chronological_index][0]
        before = tab.notes[original_index]
        planned = planned_working[working_index]
        changed = (before.string, before.fret) != (planned.string, planned.fret)
        notes[original_index] = (
            planned.model_copy(update={"reviewed": False, "user_locked": False})
            if changed
            else before.model_copy(deep=True)
        )

    changes = [
        PhraseFingeringChange(
            note_id=before.id,
            score_tick=before.score_tick,
            midi_pitch=before.midi_pitch,
            before_string=before.string,
            before_fret=before.fret,
            after_string=after.string,
            after_fret=after.fret,
        )
        for before, after in zip(tab.notes, notes, strict=True)
        if (before.string, before.fret) != (after.string, after.fret)
    ]
    selected_notes = [arranged[index] for index in selected_indices]
    return PhraseFingeringPlan(
        range=range_,
        mode=mode,
        constraints=normalized_constraints,
        notes=notes,
        changes=changes,
        selected_note_count=len(selected_indices),
        locked_note_count=sum(note.user_locked for note in selected_notes),
    )
