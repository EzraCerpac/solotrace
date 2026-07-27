# Enhanced model benchmark

Evaluated 12 EGSet12 electric-guitar performances against exact per-string JAMS/Guitar Pro ground truth. Note matches require exact MIDI pitch and onset within 50 ms.

## Results

| Route | Note F1 | Tab F1 | TDR | Median onset | Seconds/track |
| --- | ---: | ---: | ---: | ---: | ---: |
| clean-basic-pitch | 0.768 | 0.332 | 0.432 | 7.2 ms | 0.22 |
| demucs-basic-pitch | 0.666 | 0.218 | 0.328 | 7.5 ms | 1.16 |
| mix-basic-pitch | 0.529 | 0.244 | 0.461 | 7.6 ms | 0.20 |
| preview-basic-pitch | 0.493 | 0.236 | 0.479 | 9.3 ms | 1.94 |
| clean-pyin | 0.473 | 0.231 | 0.489 | 6.7 ms | 6.95 |
| clean-tabcnn | 0.469 | 0.313 | 0.667 | 11.8 ms | 0.61 |
| demucs-pyin | 0.406 | 0.194 | 0.477 | 7.9 ms | 7.62 |
| demucs-tabcnn | 0.390 | 0.244 | 0.624 | 11.7 ms | 1.53 |
| preview-tabcnn | 0.301 | 0.173 | 0.576 | 14.9 ms | 2.33 |
| mix-tabcnn | 0.278 | 0.156 | 0.559 | 13.7 ms | 0.53 |
| preview-pyin | 0.215 | 0.103 | 0.477 | 9.3 ms | 8.71 |
| mix-pyin | 0.125 | 0.069 | 0.554 | 10.7 ms | 7.05 |

## Separation

| Separator | Median SI-SDR | Mean SI-SDR |
| --- | ---: | ---: |
| preview | 4.40 dB | 3.70 dB |
| Demucs htdemucs_6s | 8.69 dB | 8.43 dB |

## Decision

Best controlled-mixture route: **demucs-basic-pitch** (note F1 0.666). Its
reported **0.218 tab F1 is historical**: that run used the retired greedy
benchmark helper, not the shipped dynamic-programming solver. Do not use it as
the current product-path score until the benchmark is rerun.

The benchmark now runs the same fingering solver as production, records an
oracle-pitch fingering score, and writes dataset, configuration, and benchmark
code SHA-256 hashes into `results.json`. TabCNN predicts string/fret directly.
EGSet12 is isolated guitar, so separation scores use a deterministic full-band
backing mixed at 0.9× lead RMS.

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
