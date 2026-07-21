from __future__ import annotations

from dataclasses import dataclass
from math import inf
from typing import Literal

from .models import Fingering, NoteEvent

FingeringMode = Literal["balanced", "easiest", "position"]
ConnectedTechnique = Literal["hammer-on", "pull-off", "slide"]
SLIDE_TECHNIQUES = {"slide", "slide-up", "slide-down"}


@dataclass(frozen=True)
class Weights:
    movement: float
    string_change: float
    fret_height: float
    open_string: float
    position_center: float


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


def validate_connected_technique_fingerings(notes: list[NoteEvent]) -> None:
    """Validate same-string, directional connections in a finished phrase."""
    for index, note in enumerate(notes):
        technique = connected_technique(note)
        if technique is None:
            continue
        if index == 0:
            raise ValueError(f"Note {note.id} cannot start with {technique}")
        if not _connection_is_playable(technique, notes[index - 1], note):
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


def _local_cost(fingering: Fingering, weights: Weights) -> float:
    open_cost = weights.open_string if fingering.fret == 0 else 0
    position_cost = abs(_hand_position(fingering) - 8) * weights.position_center
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


def assign_fingerings(
    notes: list[NoteEvent],
    tuning: list[int],
    fret_count: int,
    mode: FingeringMode = "balanced",
) -> list[NoteEvent]:
    if not notes:
        return []
    weights = WEIGHTS[mode]
    candidates: list[list[Fingering]] = []
    for note in notes:
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
            note.midi_pitch for note, choices in zip(notes, candidates, strict=True) if not choices
        )
        raise ValueError(f"MIDI pitch {missing} is outside this guitar range")

    costs: list[list[float]] = []
    parents: list[list[int]] = []
    first_technique = connected_technique(notes[0])
    if first_technique is not None:
        raise ValueError(f"Note {notes[0].id} cannot start with {first_technique}")
    costs.append([_local_cost(choice, weights) for choice in candidates[0]])
    parents.append([-1] * len(candidates[0]))

    for note_index in range(1, len(notes)):
        technique = connected_technique(notes[note_index])
        row_costs: list[float] = []
        row_parents: list[int] = []
        for current in candidates[note_index]:
            best_cost = inf
            best_parent = -1
            for parent_index, previous in enumerate(candidates[note_index - 1]):
                if technique is not None and not _connection_is_playable(
                    technique, previous, current
                ):
                    continue
                cost = (
                    costs[note_index - 1][parent_index]
                    + _transition_cost(previous, current, weights)
                    + _local_cost(current, weights)
                )
                if cost < best_cost:
                    best_cost = cost
                    best_parent = parent_index
            row_costs.append(best_cost)
            row_parents.append(best_parent)
        if all(parent < 0 for parent in row_parents):
            label = technique or "Fingering"
            raise ValueError(
                f"{label} on note {notes[note_index].id} has no playable "
                "connection from the previous note"
            )
        costs.append(row_costs)
        parents.append(row_parents)

    selected = [0] * len(notes)
    selected[-1] = min(range(len(costs[-1])), key=costs[-1].__getitem__)
    for note_index in range(len(notes) - 1, 0, -1):
        selected[note_index - 1] = parents[note_index][selected[note_index]]

    output: list[NoteEvent] = []
    for note_index, note in enumerate(notes):
        choice = candidates[note_index][selected[note_index]]
        incoming = connected_technique(note)
        next_note = notes[note_index + 1] if note_index + 1 < len(notes) else None
        outgoing = connected_technique(next_note) if next_note is not None else None
        viable_candidates = [
            candidate
            for candidate in candidates[note_index]
            if (
                incoming is None
                or note_index == 0
                or _connection_is_playable(
                    incoming,
                    candidates[note_index - 1][selected[note_index - 1]],
                    candidate,
                )
            )
            and (
                outgoing is None
                or _connection_is_playable(
                    outgoing,
                    candidate,
                    candidates[note_index + 1][selected[note_index + 1]],
                )
            )
        ]
        ranked = sorted(
            (
                candidate.model_copy(
                    update={
                        "cost": round(
                            _local_cost(candidate, weights)
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
    return output
