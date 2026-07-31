from __future__ import annotations

from dataclasses import dataclass
from math import isfinite

from pydantic import Field, field_validator, model_validator

from .models import ChordEvent, NoteEvent, StrictModel, SyncAnchor, TabDocument


class BeatMap(StrictModel):
    tempo_bpm: float = Field(gt=20, le=400)
    time_signature: tuple[int, int] = (4, 4)
    bar_offset_ticks: int = Field(default=0, ge=0)
    sync_anchors: list[SyncAnchor] = Field(min_length=2, max_length=5000)

    @field_validator("time_signature")
    @classmethod
    def validate_time_signature(cls, value: tuple[int, int]) -> tuple[int, int]:
        beats, beat_type = value
        if not 1 <= beats <= 32 or beat_type not in {2, 4, 8, 16}:
            raise ValueError(
                "Time signature needs 1–32 beats and a beat unit of 2, 4, 8, or 16"
            )
        return value

    @model_validator(mode="after")
    def validate_anchor_order(self) -> BeatMap:
        for left, right in zip(self.sync_anchors, self.sync_anchors[1:], strict=False):
            if right.audio_frame <= left.audio_frame or right.score_tick <= left.score_tick:
                raise ValueError(
                    "Sync pins must move forward in both audio and score time"
                )
        return self


@dataclass(frozen=True)
class TempoEvent:
    score_tick: int
    bpm: float


def ticks_per_measure(
    ticks_per_quarter: int,
    time_signature: tuple[int, int],
) -> int:
    beats, beat_type = time_signature
    numerator = beats * ticks_per_quarter * 4
    if numerator % beat_type:
        raise ValueError(
            "Time signature cannot use whole score ticks at this resolution"
        )
    return numerator // beat_type


def beat_map_from_tab(tab: TabDocument) -> BeatMap:
    anchors = tab.sync_anchors
    if len(anchors) < 2:
        # Existing projects can contain one pin. A staged edit still needs locked
        # start/end pins, so callers must establish them before applying.
        raise ValueError("Beat Map needs at least 2 sync pins")
    return BeatMap(
        tempo_bpm=tab.tempo_bpm,
        time_signature=tab.time_signature,
        bar_offset_ticks=getattr(tab, "bar_offset_ticks", 0),
        sync_anchors=anchors,
    )


def _inferred_coverage(tab: TabDocument) -> tuple[int, int] | None:
    events = [*tab.notes, *tab.chords.events]
    if not events:
        return None
    return (
        min(event.onset_frame for event in events),
        max(event.end_frame for event in events),
    )


def validate_beat_map(
    tab: TabDocument,
    beat_map: BeatMap,
    coverage: tuple[int, int] | None = None,
) -> BeatMap:
    measure_ticks = ticks_per_measure(tab.ticks_per_quarter, beat_map.time_signature)
    if beat_map.bar_offset_ticks >= measure_ticks:
        raise ValueError(f"Pickup must be between 0 and {measure_ticks - 1} ticks")
    required_coverage = coverage or _inferred_coverage(tab)
    if required_coverage is not None:
        start_frame, end_frame = required_coverage
        if (
            beat_map.sync_anchors[0].audio_frame > start_frame
            or beat_map.sync_anchors[-1].audio_frame < end_frame
        ):
            raise ValueError(
                "Locked first and last sync pins must cover the transcription passage"
            )
    for index, (left, right) in enumerate(
        zip(beat_map.sync_anchors, beat_map.sync_anchors[1:], strict=False),
        start=1,
    ):
        frame_span = right.audio_frame - left.audio_frame
        tick_span = right.score_tick - left.score_tick
        bpm = tick_span * tab.sample_rate * 60 / (frame_span * tab.ticks_per_quarter)
        if not isfinite(bpm) or not 20 < bpm <= 400:
            raise ValueError(
                f"Pins {index} and {index + 1} imply {bpm:.1f} BPM; use 20–400 BPM"
            )
    return beat_map


def score_tick_for_audio_frame(audio_frame: int, anchors: list[SyncAnchor]) -> int:
    if len(anchors) < 2:
        raise ValueError("Beat Map needs at least 2 sync pins")
    left, right = anchors[0], anchors[1]
    if audio_frame >= anchors[-1].audio_frame:
        left, right = anchors[-2], anchors[-1]
    else:
        for candidate_left, candidate_right in zip(anchors, anchors[1:], strict=False):
            if audio_frame <= candidate_right.audio_frame:
                left, right = candidate_left, candidate_right
                break
    progress = (audio_frame - left.audio_frame) / (right.audio_frame - left.audio_frame)
    return max(0, round(left.score_tick + progress * (right.score_tick - left.score_tick)))


def _remap_event(
    event: NoteEvent | ChordEvent,
    anchors: list[SyncAnchor],
) -> NoteEvent | ChordEvent:
    score_tick = score_tick_for_audio_frame(event.onset_frame, anchors)
    end_tick = score_tick_for_audio_frame(event.end_frame, anchors)
    return event.model_copy(
        update={
            "score_tick": score_tick,
            "duration_ticks": max(1, end_tick - score_tick),
        }
    )


def apply_beat_map(
    tab: TabDocument,
    candidate: BeatMap,
    coverage: tuple[int, int] | None = None,
) -> TabDocument:
    """Replace score timing while leaving source audio coordinates untouched."""
    beat_map = validate_beat_map(tab, candidate, coverage)
    notes = [
        _remap_event(note, beat_map.sync_anchors)
        for note in tab.notes
    ]
    chords = tab.chords.model_copy(
        update={
            "events": [
                _remap_event(chord, beat_map.sync_anchors)
                for chord in tab.chords.events
            ]
        }
    )
    return tab.model_copy(
        update={
            "tempo_bpm": beat_map.tempo_bpm,
            "time_signature": beat_map.time_signature,
            "bar_offset_ticks": beat_map.bar_offset_ticks,
            "sync_anchors": beat_map.sync_anchors,
            "notes": notes,
            "chords": chords,
        }
    )


def tempo_events_for_tab(tab: TabDocument) -> list[TempoEvent]:
    events = [TempoEvent(score_tick=0, bpm=tab.tempo_bpm)]
    for left, right in zip(tab.sync_anchors, tab.sync_anchors[1:], strict=False):
        bpm = (
            (right.score_tick - left.score_tick)
            * tab.sample_rate
            * 60
            / ((right.audio_frame - left.audio_frame) * tab.ticks_per_quarter)
        )
        if not isfinite(bpm) or not 20 < bpm <= 400:
            continue
        rounded = round(bpm, 3)
        if left.score_tick == events[-1].score_tick:
            events[-1] = TempoEvent(score_tick=left.score_tick, bpm=rounded)
        elif abs(events[-1].bpm - rounded) >= 0.001:
            events.append(TempoEvent(score_tick=left.score_tick, bpm=rounded))
    return events


def pickup_midi_shift(tab: TabDocument) -> int:
    offset = getattr(tab, "bar_offset_ticks", 0)
    if not offset:
        return 0
    return ticks_per_measure(tab.ticks_per_quarter, tab.time_signature) - offset
