from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf
from solotrace.audio import (
    AudioProcessingCancelled,
    create_preview_stems,
    transcribe_pyin,
)


def test_pyin_transcription_keeps_last_onset_segment(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("solotrace.audio.LOCAL_CHUNK_SECONDS", 1.0)
    sample_rate = 22_050
    audio = np.zeros(sample_rate * 3, dtype=np.float32)
    for index, frequency in enumerate((220.0, 261.63, 329.63)):
        start = round((0.2 + index * 0.85) * sample_rate)
        length = round(0.55 * sample_rate)
        time = np.arange(length) / sample_rate
        envelope = np.sin(np.linspace(0, np.pi, length)) ** 0.35
        audio[start : start + length] = np.sin(2 * np.pi * frequency * time) * envelope * 0.5
    path = tmp_path / "lead.wav"
    sf.write(path, audio, sample_rate)

    document = transcribe_pyin(
        path,
        start_s=0,
        end_s=3,
        tuning=[40, 45, 50, 55, 59, 64],
        fret_count=22,
    )

    assert [note.midi_pitch for note in document.notes] == [57, 60, 64]
    assert document.notes == sorted(
        document.notes,
        key=lambda note: note.audio_onset_s,
    )
    assert all(note.alternatives for note in document.notes)
    assert all(
        left.audio_offset_s <= right.audio_onset_s
        for left, right in zip(document.notes, document.notes[1:], strict=False)
    )


def test_pyin_honors_drop_d_range_and_repeated_attacks(tmp_path) -> None:
    sample_rate = 22_050
    audio = np.zeros(sample_rate * 2, dtype=np.float32)
    for start_s in (0.2, 0.85):
        start = round(start_s * sample_rate)
        length = round(0.45 * sample_rate)
        time = np.arange(length) / sample_rate
        envelope = np.sin(np.linspace(0, np.pi, length)) ** 0.35
        audio[start : start + length] += np.sin(2 * np.pi * 73.416 * time) * envelope * 0.5
    path = tmp_path / "drop-d.wav"
    sf.write(path, audio, sample_rate)

    document = transcribe_pyin(
        path,
        start_s=0,
        end_s=2,
        tuning=[38, 45, 50, 55, 59, 64],
        fret_count=22,
    )

    assert [note.midi_pitch for note in document.notes] == [38, 38]
    assert document.notes[0].audio_offset_s <= document.notes[1].audio_onset_s


def test_preview_stems_stream_full_song_and_limit_lead_to_passage(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("solotrace.audio.LOCAL_CHUNK_SECONDS", 1.0)
    sample_rate = 22_050
    seconds = 4
    time = np.arange(sample_rate * seconds) / sample_rate
    left = np.sin(2 * np.pi * 220 * time).astype(np.float32) * 0.25
    right = np.sin(2 * np.pi * 330 * time).astype(np.float32) * 0.2
    original = np.column_stack((left, right))
    original_path = tmp_path / "original.wav"
    lead_path = tmp_path / "lead.wav"
    backing_path = tmp_path / "backing.wav"
    sf.write(original_path, original, sample_rate)

    progress: list[str] = []
    returned_rate, duration = create_preview_stems(
        original_path,
        lead_path,
        backing_path,
        1,
        3,
        progress=progress.append,
    )
    lead, _ = sf.read(lead_path, always_2d=True)
    backing, _ = sf.read(backing_path, always_2d=True)

    assert returned_rate == sample_rate
    assert duration == seconds
    assert lead.shape == original.shape
    assert backing.shape == original.shape
    assert np.max(np.abs(lead[: sample_rate // 2])) == 0
    assert np.max(np.abs(lead[-sample_rate // 2 :])) == 0
    assert np.max(np.abs(lead[sample_rate : sample_rate * 3])) > 0
    assert len(progress) == 2
    assert progress[-1].startswith("Separated")


def test_preview_chunking_can_be_cancelled_between_chunks(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("solotrace.audio.LOCAL_CHUNK_SECONDS", 1.0)
    sample_rate = 8_000
    original = np.zeros((sample_rate * 4, 2), dtype=np.float32)
    original_path = tmp_path / "original.wav"
    sf.write(original_path, original, sample_rate)
    completed: list[str] = []

    with pytest.raises(AudioProcessingCancelled, match="Draft cancelled"):
        create_preview_stems(
            original_path,
            tmp_path / "lead.wav",
            tmp_path / "backing.wav",
            0,
            4,
            progress=completed.append,
            cancelled=lambda: bool(completed),
        )

    assert len(completed) == 1
