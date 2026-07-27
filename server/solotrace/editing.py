from __future__ import annotations

from .fingering import legal_fingerings
from .models import NoteEvent, Project
from .timing import audio_frame_to_score_tick


def normalize_edited_notes(
    project: Project,
    submitted: list[NoteEvent],
) -> list[NoteEvent]:
    """Rebuild fields that are derived from an edited note's time and pitch."""
    note_ids = [note.id for note in submitted]
    if len(note_ids) != len(set(note_ids)):
        raise ValueError("Note ids must be unique")

    normalized: list[NoteEvent] = []
    for note in submitted:
        if (
            note.audio_onset_s < project.passage.start_s
            or note.audio_offset_s > project.passage.end_s
            or note.audio_offset_s > project.duration_s
        ):
            raise ValueError("Notes must stay inside the transcription range")

        onset_frame = round(note.audio_onset_s * project.tab.sample_rate)
        end_frame = max(
            onset_frame + 1,
            round(note.audio_offset_s * project.tab.sample_rate),
        )
        score_tick = audio_frame_to_score_tick(
            onset_frame,
            project.tab.sync_anchors,
        )
        end_tick = audio_frame_to_score_tick(
            end_frame,
            project.tab.sync_anchors,
        )
        alternatives = legal_fingerings(
            note.midi_pitch,
            project.tab.sounding_tuning,
            project.tab.available_fret_count,
        )
        if not alternatives:
            raise ValueError(f"{note.midi_pitch} is outside this guitar's tuning and fret range")
        chosen = next(
            (
                alternative
                for alternative in alternatives
                if (alternative.string, alternative.fret) == (note.string, note.fret)
            ),
            None,
        )
        if chosen is None:
            chosen = min(
                alternatives,
                key=lambda alternative: (
                    abs(alternative.fret - note.fret) + abs(alternative.string - note.string),
                    alternative.fret,
                ),
            )
        ranked = sorted(
            (
                alternative.model_copy(
                    update={
                        "cost": round(
                            abs(alternative.fret - chosen.fret)
                            + 0.35 * abs(alternative.string - chosen.string),
                            3,
                        )
                    }
                )
                for alternative in alternatives
            ),
            key=lambda alternative: alternative.cost,
        )
        normalized.append(
            note.model_copy(
                update={
                    "onset_frame": onset_frame,
                    "end_frame": end_frame,
                    "score_tick": score_tick,
                    "duration_ticks": max(1, end_tick - score_tick),
                    "string": chosen.string,
                    "fret": chosen.fret,
                    "alternatives": ranked,
                }
            )
        )
    return sorted(normalized, key=lambda note: (note.audio_onset_s, note.midi_pitch))
