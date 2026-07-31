from __future__ import annotations

import pytest
from pydantic import ValidationError

from solotrace.beat_map import (
    BeatMap,
    apply_beat_map,
    pickup_midi_shift,
    tempo_events_for_tab,
    ticks_per_measure,
)
from solotrace.demo import ensure_demo
from solotrace.models import SyncAnchor
from solotrace.storage import ProjectStore


def _anchors(sample_rate: int) -> list[SyncAnchor]:
    return [
        SyncAnchor(audio_frame=0, score_tick=0),
        SyncAnchor(audio_frame=sample_rate, score_tick=960),
        SyncAnchor(audio_frame=sample_rate * 3 // 2, score_tick=1_920),
    ]


def test_apply_beat_map_retimes_score_fields_and_preserves_audio(tmp_path) -> None:
    project = ensure_demo(ProjectStore(tmp_path))
    original = project.tab
    last_frame = round(project.duration_s * original.sample_rate)
    last_tick = round(last_frame * 2 * original.ticks_per_quarter / original.sample_rate)
    beat_map = BeatMap(
        tempo_bpm=120,
        time_signature=(4, 4),
        bar_offset_ticks=480,
        sync_anchors=[
            SyncAnchor(audio_frame=0, score_tick=0),
            SyncAnchor(audio_frame=last_frame, score_tick=last_tick),
        ],
    )

    changed = apply_beat_map(original, beat_map)

    assert changed is not original
    assert changed.notes[0].onset_frame == original.notes[0].onset_frame
    assert changed.notes[0].audio_onset_s == original.notes[0].audio_onset_s
    assert changed.notes[0].score_tick == round(
        original.notes[0].onset_frame * 2 * original.ticks_per_quarter / original.sample_rate
    )
    assert changed.chords.events[0].onset_frame == original.chords.events[0].onset_frame
    assert getattr(changed, "bar_offset_ticks") == 480
    assert pickup_midi_shift(changed) == 1_440


def test_beat_map_rejects_crossed_pins_extreme_segments_and_bad_pickup(tmp_path) -> None:
    tab = ensure_demo(ProjectStore(tmp_path)).tab
    with pytest.raises(ValidationError, match="move forward"):
        BeatMap(
            tempo_bpm=120,
            sync_anchors=[
                SyncAnchor(audio_frame=100, score_tick=0),
                SyncAnchor(audio_frame=99, score_tick=480),
            ],
        )
    with pytest.raises(ValueError, match="use 20–400 BPM"):
        apply_beat_map(
            tab,
            BeatMap(
                tempo_bpm=120,
                sync_anchors=[
                    SyncAnchor(audio_frame=0, score_tick=0),
                    SyncAnchor(audio_frame=tab.sample_rate, score_tick=9_600),
                ],
            ),
            coverage=(0, tab.sample_rate),
        )
    with pytest.raises(ValueError, match="Pickup"):
        apply_beat_map(
            tab,
            BeatMap(
                tempo_bpm=120,
                bar_offset_ticks=1_920,
                sync_anchors=_anchors(tab.sample_rate),
            ),
        )
    with pytest.raises(ValueError, match="whole score ticks"):
        ticks_per_measure(481, (3, 16))


def test_variable_tempo_events_are_derived_from_pin_segments(tmp_path) -> None:
    tab = ensure_demo(ProjectStore(tmp_path)).tab.model_copy(
        update={"sync_anchors": _anchors(48_000), "sample_rate": 48_000}
    )

    assert tempo_events_for_tab(tab) == [
        # One second for two quarter notes, then half a second for two.
        tempo_events_for_tab(tab)[0].__class__(score_tick=0, bpm=120),
        tempo_events_for_tab(tab)[0].__class__(score_tick=960, bpm=240),
    ]
