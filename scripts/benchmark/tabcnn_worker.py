from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import librosa
import torch
from amt_tools import tools
from amt_tools.features import CQT
from amt_tools.inference import run_offline
from amt_tools.transcribe import (
    ComboEstimator,
    StackedMultiPitchCollapser,
    StackedNoteTranscriber,
    TablatureWrapper,
)

TUNING = [40, 45, 50, 55, 59, 64]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest: dict[str, str] = json.loads(args.manifest.read_text())
    feature = CQT(
        sample_rate=22_050,
        hop_length=512,
        n_bins=192,
        bins_per_octave=24,
    )
    profile = tools.GuitarProfile(num_frets=19)
    model = torch.load(
        args.checkpoint,
        map_location="cpu",
        weights_only=False,
    )
    model.device = "cpu"
    model.change_device()
    model.eval()
    estimator = ComboEstimator(
        [
            TablatureWrapper(profile=profile),
            StackedNoteTranscriber(profile=profile),
            StackedMultiPitchCollapser(profile=profile),
        ]
    )
    results: dict[str, object] = {}
    total = len(manifest)
    for index, (key, audio_path) in enumerate(manifest.items(), start=1):
        started = time.perf_counter()
        audio, _ = librosa.load(audio_path, sr=22_050, mono=True)
        track_data = {
            tools.KEY_TRACK: key,
            tools.KEY_FEATS: feature.process_audio(audio),
            tools.KEY_TIMES: feature.get_times(audio),
        }
        with torch.no_grad():
            predictions = run_offline(track_data, model, estimator)
        notes = []
        for string_index, (pitches, intervals) in predictions[tools.KEY_NOTES].items():
            for pitch, interval in zip(pitches, intervals, strict=True):
                midi_pitch = int(round(float(pitch)))
                fret = midi_pitch - TUNING[int(string_index)]
                if 0 <= fret <= 19:
                    notes.append(
                        {
                            "onset": float(interval[0]),
                            "offset": float(interval[1]),
                            "pitch": midi_pitch,
                            "string_index": int(string_index),
                            "fret": fret,
                        }
                    )
        notes.sort(key=lambda note: (note["onset"], note["pitch"]))
        results[key] = {
            "seconds": time.perf_counter() - started,
            "notes": notes,
        }
        print(f"TabCNN {index}/{total}: {key}", file=sys.stderr, flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
