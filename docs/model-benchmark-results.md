# Enhanced model benchmark

Evaluated 12 EGSet12 electric-guitar performances against exact per-string JAMS/Guitar Pro ground truth. Note matches require exact MIDI pitch and onset within 50 ms.

## Results

| Route | Note F1 | Tab F1 | TDR | Median onset | Seconds/track |
| --- | ---: | ---: | ---: | ---: | ---: |
| clean-basic-pitch | 0.768 | 0.438 | 0.571 | 7.2 ms | 0.21 |
| demucs-basic-pitch | 0.669 | 0.344 | 0.514 | 7.5 ms | 1.71 |
| mix-basic-pitch | 0.529 | 0.275 | 0.520 | 7.6 ms | 0.18 |
| preview-basic-pitch | 0.493 | 0.227 | 0.460 | 9.3 ms | 2.12 |
| clean-pyin | 0.473 | 0.231 | 0.489 | 6.7 ms | 8.51 |
| clean-tabcnn | 0.469 | 0.313 | 0.667 | 11.8 ms | 0.66 |
| demucs-pyin | 0.404 | 0.196 | 0.484 | 7.9 ms | 9.08 |
| demucs-tabcnn | 0.395 | 0.251 | 0.635 | 12.1 ms | 2.13 |
| preview-tabcnn | 0.301 | 0.173 | 0.576 | 14.9 ms | 2.48 |
| mix-tabcnn | 0.278 | 0.156 | 0.559 | 13.7 ms | 0.62 |
| preview-pyin | 0.215 | 0.103 | 0.477 | 9.3 ms | 9.62 |
| mix-pyin | 0.125 | 0.069 | 0.554 | 10.7 ms | 8.05 |

## Separation

| Separator | Median SI-SDR | Mean SI-SDR |
| --- | ---: | ---: |
| preview | 4.40 dB | 3.70 dB |
| Demucs htdemucs_6s | 8.72 dB | 8.57 dB |

## Decision

Best controlled-mixture route: **demucs-basic-pitch** (note F1 0.669, tab F1 0.344).

With ground-truth pitches, the shipped dynamic-programming fingering solver scores **0.646 tab F1**. This separates fingering ambiguity from pitch-detection errors.

Beta note-F1 gate for `demucs-basic-pitch`: **pass** at 0.669; minimum 0.646 from the 0.666 baseline.

Tab F1 uses SoloTrace's deterministic fingering for pYIN and Basic Pitch; TabCNN predicts string/fret directly. EGSet12 is isolated guitar, so separation scores use a deterministic full-band backing mixed at 0.9× lead RMS.

Dataset: [EGSet12, CC BY 4.0](https://zenodo.org/records/11406378).

## Reproduce

After `./scripts/install-enhanced-models.sh`, download EGSet12 and the authors' CC0 inference code:

```bash
mkdir -p .benchmarks
curl -L https://zenodo.org/api/records/11406378/files-archive \
  -o .benchmarks/egset12.zip
unzip .benchmarks/egset12.zip -d .benchmarks/egset12
git clone https://github.com/robust-guitar-tabs/code \
  .benchmarks/robust-guitar-tabs-code
uv pip install --python .workers/separate/bin/python -e \
  .benchmarks/robust-guitar-tabs-code/AMT-Tools
```

Then run:

```bash
env UV_CACHE_DIR=.uv-cache \
  MPLCONFIGDIR=.benchmarks/matplotlib-cache \
  PYTHONPATH=.benchmarks/robust-guitar-tabs-code/AMT-Tools \
  uv run python scripts/benchmark_models.py --limit 12
```
