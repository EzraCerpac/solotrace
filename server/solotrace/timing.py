from __future__ import annotations

from .models import SyncAnchor


def audio_frame_to_score_tick(
    audio_frame: int,
    anchors: list[SyncAnchor],
) -> int:
    """Map performance frames to score ticks with piecewise-linear anchors."""
    if not anchors:
        return 0
    ordered = sorted(anchors, key=lambda anchor: anchor.audio_frame)
    if audio_frame <= ordered[0].audio_frame:
        return ordered[0].score_tick
    for left, right in zip(ordered, ordered[1:], strict=False):
        if audio_frame <= right.audio_frame:
            frame_span = right.audio_frame - left.audio_frame
            if frame_span == 0:
                return right.score_tick
            progress = (audio_frame - left.audio_frame) / frame_span
            return round(left.score_tick + progress * (right.score_tick - left.score_tick))
    last = ordered[-1]
    previous = ordered[-2] if len(ordered) > 1 else last
    frame_span = last.audio_frame - previous.audio_frame
    if frame_span == 0:
        return last.score_tick
    ticks_per_frame = (last.score_tick - previous.score_tick) / frame_span
    return max(
        0,
        round(last.score_tick + (audio_frame - last.audio_frame) * ticks_per_frame),
    )
