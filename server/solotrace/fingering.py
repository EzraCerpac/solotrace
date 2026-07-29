from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .models import Fingering, NoteEvent

FingeringMode = Literal["balanced", "easiest", "position"]
ConnectedTechnique = Literal["hammer-on", "pull-off", "slide"]
SLIDE_TECHNIQUES = {"slide", "slide-up", "slide-down"}
Voicing = tuple[Fingering, ...]


@dataclass(frozen=True)
class Weights:
    movement: float
    string_change: float
    fret_height: float
    open_string: float
    position_center: float


@dataclass(frozen=True)
class GroupState:
    cost: float
    choices: Voicing
    parent_group_index: int


WEIGHTS: dict[FingeringMode, Weights] = {
    "balanced": Weights(1.0, 0.36, 0.018, 0.22, 0.03),
    "easiest": Weights(1.35, 0.22, 0.06, -0.2, 0.02),
    "position": Weights(2.25, 0.14, 0.012, 0.4, 0.12),
}


def connected_technique(note: NoteEvent) -> ConnectedTechnique | None:
    """Return a connection owned by its destination note."""
    connections: list[ConnectedTechnique] = []
    if "hammer-on" in note.techniques:
        connections.append("hammer-on")
    if "pull-off" in note.techniques:
        connections.append("pull-off")
    if any(technique in SLIDE_TECHNIQUES for technique in note.techniques):
        connections.append("slide")
    if len(connections) > 1:
        raise ValueError(f"Note {note.id} has conflicting connected techniques")
    return connections[0] if connections else None


def _connection_is_playable(
    technique: ConnectedTechnique,
    previous: Fingering | NoteEvent,
    current: Fingering | NoteEvent,
) -> bool:
    if previous.string != current.string:
        return False
    if technique == "hammer-on":
        return current.fret > previous.fret
    if technique == "pull-off":
        return current.fret < previous.fret
    return current.fret != previous.fret


def _chronological_notes(notes: list[NoteEvent]) -> list[tuple[int, NoteEvent]]:
    return sorted(
        enumerate(notes),
        key=lambda indexed: (indexed[1].onset_frame, indexed[0]),
    )


def validate_connected_technique_fingerings(notes: list[NoteEvent]) -> None:
    """Validate same-string, directional connections in a finished phrase."""
    chronological = [note for _, note in _chronological_notes(notes)]
    for index, note in enumerate(chronological):
        technique = connected_technique(note)
        if technique is None:
            continue
        if index == 0:
            raise ValueError(f"Note {note.id} cannot start with {technique}")
        if not _connection_is_playable(technique, chronological[index - 1], note):
            raise ValueError(
                f"{technique} on note {note.id} must connect from the previous "
                "note on the same string"
            )


def legal_fingerings(
    midi_pitch: int,
    tuning: list[int],
    fret_count: int,
) -> list[Fingering]:
    """Enumerate positions, using guitar string 1 for the highest string."""
    positions: list[Fingering] = []
    string_count = len(tuning)
    for low_index, open_pitch in enumerate(tuning):
        fret = midi_pitch - open_pitch
        if 0 <= fret <= fret_count:
            string_number = string_count - low_index
            positions.append(
                Fingering(
                    string=string_number,
                    fret=fret,
                    label=f"String {string_number}, fret {fret}",
                )
            )
    return sorted(positions, key=lambda item: (item.fret, item.string))


def _hand_position(fingering: Fingering) -> float:
    if fingering.fret == 0:
        return 1
    return max(1, fingering.fret - 1)


def _local_cost(
    fingering: Fingering,
    weights: Weights,
    preferred_fret: int | None = None,
) -> float:
    open_cost = weights.open_string if fingering.fret == 0 else 0
    center = preferred_fret if preferred_fret is not None else 8
    position_cost = abs(_hand_position(fingering) - center) * weights.position_center
    return fingering.fret * weights.fret_height + open_cost + position_cost


def _transition_cost(previous: Fingering, current: Fingering, weights: Weights) -> float:
    movement = abs(_hand_position(previous) - _hand_position(current))
    string_change = abs(previous.string - current.string)
    stretch = max(0, abs(previous.fret - current.fret) - 5)
    return (
        movement * weights.movement
        + string_change * weights.string_change
        + stretch * 1.4
    )


def _note_groups(notes: list[NoteEvent]) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    start = 0
    for index in range(1, len(notes) + 1):
        if index == len(notes) or notes[index].onset_frame != notes[start].onset_frame:
            groups.append((start, index))
            start = index
    return groups


def _keep_lower_cost(
    states: dict[tuple[int, int], GroupState],
    key: tuple[int, int],
    candidate: GroupState,
) -> None:
    current = states.get(key)
    if current is None or candidate.cost < current.cost:
        states[key] = candidate


def _group_states(
    notes: list[NoteEvent],
    candidates: list[list[Fingering]],
    start: int,
    end: int,
    weights: Weights,
    preferred_fret: int | None,
    previous_states: list[GroupState] | None,
) -> list[GroupState]:
    """Keep only the cheapest path for each used-string mask and terminal string."""
    first_technique = connected_technique(notes[start])
    if previous_states is None and first_technique is not None:
        raise ValueError(f"Note {notes[start].id} cannot start with {first_technique}")

    layer: dict[tuple[int, int], GroupState] = {}
    for choice in candidates[start]:
        used_strings = 1 << (choice.string - 1)
        key = (used_strings, choice.string)
        if previous_states is None:
            _keep_lower_cost(
                layer,
                key,
                GroupState(
                    cost=_local_cost(choice, weights, preferred_fret),
                    choices=(choice,),
                    parent_group_index=-1,
                ),
            )
            continue
        for parent_index, previous in enumerate(previous_states):
            if first_technique is not None and not _connection_is_playable(
                first_technique,
                previous.choices[-1],
                choice,
            ):
                continue
            _keep_lower_cost(
                layer,
                key,
                GroupState(
                    cost=(
                        previous.cost
                        + _transition_cost(previous.choices[-1], choice, weights)
                        + _local_cost(choice, weights, preferred_fret)
                    ),
                    choices=(choice,),
                    parent_group_index=parent_index,
                ),
            )

    if not layer:
        label = first_technique or "Fingering"
        raise ValueError(
            f"{label} on note {notes[start].id} has no playable "
            "connection from the previous note"
        )

    for note_index in range(start + 1, end):
        next_layer: dict[tuple[int, int], GroupState] = {}
        technique = connected_technique(notes[note_index])
        for (used_strings, _), state in layer.items():
            previous = state.choices[-1]
            for choice in candidates[note_index]:
                string_bit = 1 << (choice.string - 1)
                if used_strings & string_bit:
                    continue
                if technique is not None and not _connection_is_playable(
                    technique,
                    previous,
                    choice,
                ):
                    continue
                next_state = GroupState(
                    cost=(
                        state.cost
                        + _transition_cost(previous, choice, weights)
                        + _local_cost(choice, weights, preferred_fret)
                    ),
                    choices=(*state.choices, choice),
                    parent_group_index=state.parent_group_index,
                )
                _keep_lower_cost(
                    next_layer,
                    (used_strings | string_bit, choice.string),
                    next_state,
                )
        if not next_layer:
            raise _unplayable_voicing_error(notes, start, end)
        layer = next_layer

    terminal_states: dict[tuple[int, int], GroupState] = {}
    for state in layer.values():
        terminal = state.choices[-1]
        _keep_lower_cost(
            terminal_states,
            (terminal.string, terminal.fret),
            state,
        )
    return list(terminal_states.values())


def _unplayable_voicing_error(
    notes: list[NoteEvent],
    start: int,
    end: int,
) -> ValueError:
    note_ids = ", ".join(note.id for note in notes[start:end])
    return ValueError(
        f"Simultaneous notes {note_ids} at frame {notes[start].onset_frame} "
        "have no playable voicing on distinct strings"
    )


def assign_fingerings(
    notes: list[NoteEvent],
    tuning: list[int],
    fret_count: int,
    mode: FingeringMode = "balanced",
    preferred_fret: int | None = None,
) -> list[NoteEvent]:
    if not notes:
        return []
    weights = WEIGHTS[mode]
    indexed_notes = _chronological_notes(notes)
    chronological_notes = [note for _, note in indexed_notes]
    candidates: list[list[Fingering]] = []
    for note in chronological_notes:
        choices = legal_fingerings(note.midi_pitch, tuning, fret_count)
        if note.user_locked:
            locked = next(
                (
                    choice
                    for choice in choices
                    if (choice.string, choice.fret) == (note.string, note.fret)
                ),
                None,
            )
            if locked is None:
                raise ValueError(
                    f"Locked position for note {note.id} is no longer playable"
                )
            choices = [locked]
        candidates.append(choices)
    if any(not choices for choices in candidates):
        missing = next(
            note.midi_pitch
            for note, choices in zip(chronological_notes, candidates, strict=True)
            if not choices
        )
        raise ValueError(f"MIDI pitch {missing} is outside this guitar range")

    groups = _note_groups(chronological_notes)
    group_history: list[list[GroupState]] = []
    previous_states: list[GroupState] | None = None
    for start, end in groups:
        if end - start > len(tuning):
            raise _unplayable_voicing_error(chronological_notes, start, end)
        states = _group_states(
            chronological_notes,
            candidates,
            start,
            end,
            weights,
            preferred_fret,
            previous_states,
        )
        group_history.append(states)
        previous_states = states

    selected = [0] * len(groups)
    selected[-1] = min(
        range(len(group_history[-1])),
        key=lambda index: group_history[-1][index].cost,
    )
    for group_index in range(len(groups) - 1, 0, -1):
        selected[group_index - 1] = group_history[group_index][
            selected[group_index]
        ].parent_group_index

    selected_choices: list[Fingering] = [candidates[0][0]] * len(chronological_notes)
    group_by_note = [0] * len(chronological_notes)
    for group_index, (start, end) in enumerate(groups):
        choices = group_history[group_index][selected[group_index]].choices
        selected_choices[start:end] = choices
        group_by_note[start:end] = [group_index] * (end - start)

    output: list[NoteEvent] = []
    for note_index, note in enumerate(chronological_notes):
        choice = selected_choices[note_index]
        incoming = connected_technique(note)
        next_note = (
            chronological_notes[note_index + 1]
            if note_index + 1 < len(chronological_notes)
            else None
        )
        outgoing = connected_technique(next_note) if next_note is not None else None
        group_start, group_end = groups[group_by_note[note_index]]
        sibling_strings = {
            selected_choices[index].string
            for index in range(group_start, group_end)
            if index != note_index
        }
        viable_candidates = [
            candidate
            for candidate in candidates[note_index]
            if candidate.string not in sibling_strings
            and (
                incoming is None
                or note_index == 0
                or _connection_is_playable(
                    incoming,
                    selected_choices[note_index - 1],
                    candidate,
                )
            )
            and (
                outgoing is None
                or _connection_is_playable(
                    outgoing,
                    candidate,
                    selected_choices[note_index + 1],
                )
            )
        ]
        ranked = sorted(
            (
                candidate.model_copy(
                    update={
                        "cost": round(
                            _local_cost(candidate, weights, preferred_fret)
                            + _transition_cost(choice, candidate, weights),
                            3,
                        )
                    }
                )
                for candidate in viable_candidates
            ),
            key=lambda item: item.cost,
        )
        fingering_confidence = (
            1.0 if len(ranked) == 1 else max(0.62, 0.93 - 0.05 * (len(ranked) - 1))
        )
        output.append(
            note.model_copy(
                update={
                    "string": choice.string,
                    "fret": choice.fret,
                    "alternatives": ranked,
                    "confidence": note.confidence.model_copy(
                        update={"fingering": fingering_confidence}
                    ),
                }
            )
        )
    restored = output.copy()
    for chronological_index, (original_index, _) in enumerate(indexed_notes):
        restored[original_index] = output[chronological_index]
    return restored
