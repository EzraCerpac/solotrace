from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "benchmark_models.py"
SPEC = importlib.util.spec_from_file_location("benchmark_models", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_beta_note_f1_gate_allows_at_most_point_zero_two_regression() -> None:
    summary = [{"route": MODULE.BETA_ROUTE, "note_f1": 0.646}]

    gate = MODULE.beta_note_f1_gate(summary)

    assert gate["passed"] is True
    assert gate["minimum_note_f1"] == 0.646


def test_beta_note_f1_gate_rejects_larger_regression() -> None:
    summary = [{"route": MODULE.BETA_ROUTE, "note_f1": 0.645}]

    assert MODULE.beta_note_f1_gate(summary)["passed"] is False


def test_production_fingering_filters_unplayable_and_short_events() -> None:
    notes = [
        {"onset": 0.0, "offset": 0.2, "pitch": 39},
        {"onset": 0.2, "offset": 0.24, "pitch": 64},
        {"onset": 0.4, "offset": 0.6, "pitch": 64},
    ]

    arranged = MODULE.add_production_fingering(notes)

    assert [note["pitch"] for note in arranged] == [64]
