from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import soundfile as sf

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "lead_separation_benchmark.py"
SPEC = importlib.util.spec_from_file_location("lead_separation_benchmark", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_load_normalizes_mono_to_stereo(tmp_path: Path) -> None:
    path = tmp_path / "mono.wav"
    sf.write(path, np.linspace(-1, 1, 200, dtype=np.float32), 8_000)

    audio, sample_rate = MODULE._load(path)

    assert sample_rate == 8_000
    assert audio.shape == (200, 2)
    np.testing.assert_array_equal(audio[:, 0], audio[:, 1])


def test_alignment_recovers_integer_latency() -> None:
    rng = np.random.default_rng(7)
    reference = rng.standard_normal((8_000, 2)).astype(np.float32)
    estimate = np.pad(reference, ((240, 0), (0, 0)))[: len(reference)]

    aligned, lag = MODULE.align(reference, estimate, 8_000)

    assert lag == 240
    assert np.corrcoef(reference[:-240].reshape(-1), aligned[:-240].reshape(-1))[0, 1] > 0.99
    np.testing.assert_array_equal(aligned[-240:], 0)


def test_projection_shares_identify_rhythm_leakage() -> None:
    rng = np.random.default_rng(4)
    lead = rng.standard_normal((2_000, 2)).astype(np.float32)
    rhythm = rng.standard_normal((2_000, 2)).astype(np.float32)
    other = rng.standard_normal((2_000, 2)).astype(np.float32)
    estimate = lead + 0.7 * rhythm

    shares = MODULE.projection_shares(estimate, lead, rhythm, other)

    assert shares["lead"] > shares["rhythm"] > shares["other"]
    assert shares["other"] < 1e-8


def test_shift_notes_preserves_metadata() -> None:
    notes = [{"onset": 1.0, "offset": 1.4, "pitch": 69}]

    shifted = MODULE.shift_notes(notes, -0.25)

    assert shifted == [{"onset": 0.75, "offset": 1.15, "pitch": 69}]
    assert notes[0]["onset"] == 1.0
