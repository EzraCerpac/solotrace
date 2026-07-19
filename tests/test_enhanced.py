from __future__ import annotations

import numpy as np
import soundfile as sf
from solotrace.enhanced import tab_from_basic_pitch_events


def test_basic_pitch_events_keep_audio_time_and_playable_fingering(tmp_path) -> None:
    sample_rate = 22_050
    rhythm_path = tmp_path / "rhythm.wav"
    time = np.arange(sample_rate * 3) / sample_rate
    clicks = np.zeros_like(time, dtype=np.float32)
    clicks[:: sample_rate // 2] = 0.8
    sf.write(rhythm_path, clicks, sample_rate)

    tab = tab_from_basic_pitch_events(
        [
            {
                "onset": 0.25,
                "offset": 0.8,
                "pitch": 69,
                "confidence": 0.9,
                "bends": [0, 0.5, 1.0, 1.5, 2.2, 2.8, 3.0, 3.0],
            },
            {
                "onset": 0.25,
                "offset": 0.65,
                "pitch": 72,
                "confidence": 0.7,
                "bends": [],
            },
        ],
        rhythm_path,
        start_s=1.0,
        end_s=2.0,
        sample_rate=sample_rate,
        tuning=[40, 45, 50, 55, 59, 64],
        fret_count=22,
    )

    assert [note.audio_onset_s for note in tab.notes] == [1.25, 1.25]
    assert tab.notes[0].onset_frame == round(1.25 * sample_rate)
    assert "bend" in tab.notes[0].techniques
    assert all(
        note.midi_pitch
        == tab.tuning[len(tab.tuning) - note.string] + note.fret
        for note in tab.notes
    )
    assert tab.sync_anchors
