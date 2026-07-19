# Local model evaluation

SoloTrace ships with the smaller preview + pYIN path. It starts immediately,
keeps audio private, and gives the editor a dependable fallback. Two higher-cost
workers were run successfully on Apple Silicon and remain an explicit product
choice rather than a hidden download.

## Separation: Demucs-MLX

Verified stack: Python 3.11, `demucs-mlx[convert]==1.4.4`, MLX `0.31.2`, model
`htdemucs_6s`.

```bash
uv venv --python 3.11 .workers/separate
uv pip install --python .workers/separate/bin/python \
  'demucs-mlx[convert]==1.4.4'

.workers/separate/bin/demucs-mlx \
  -n htdemucs_6s \
  -o /absolute/output \
  --shifts 0 \
  --overlap 0.25 \
  --batch-size 1 \
  --write-workers 1 \
  --prefetch-tracks 0 \
  /absolute/song.wav
```

The first run converts and caches roughly 105 MB. The six outputs are drums,
bass, other, vocals, guitar, and piano. This is **all guitar**, not reliably the
solo guitar. A default backing can sum the five non-guitar stems. A Labs
alternative can subtract the guitar estimate from the original; it reconstructs
the mix exactly as a pair but retains guitar missed by the separator.

## Transcription: Basic Pitch CoreML

Verified stack: Python 3.11, `basic-pitch==0.4.0`, `coremltools==9.0`, and
`setuptools==80.9.0`.

```bash
uv venv --python 3.11 .workers/transcribe
uv pip install --python .workers/transcribe/bin/python \
  basic-pitch==0.4.0 coremltools==9.0 setuptools==80.9.0
```

A generated 440 Hz tone produced one A4 event and 83 pitch-bend frames through
the CoreML model. Event timestamps are relative to the input clip; SoloTrace
must add the marked-passage offset and preserve the returned contour rather than
Basic Pitch's default 120 BPM MIDI timing.

Keep this worker separate from Demucs. Demucs conversion currently resolves
`setuptools==83`, while Basic Pitch's current resampling dependency still needs
the `pkg_resources` module present in setuptools 80.

## Decision left visible

The stronger workers improve some recordings but add a large first-run download,
longer processing, extra dependency locks, and an all-guitar-versus-lead-guitar
ambiguity. The next product decision is whether to:

1. add an explicit “Install enhanced local models” action;
2. benchmark both workers on a small set of the user's actual solos first; or
3. keep the instant draft and invest in correction speed.

No cloud account or API key is needed for any current SoloTrace feature.
