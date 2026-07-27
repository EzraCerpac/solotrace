# Chord recognition benchmark results

SoloTrace’s pinned ChordMini ONNX engine clears the shipping gate on the full
GuitarSet accompaniment set. It beats the non-shipping librosa chroma baseline
on both required metrics: maj/min WCSR by 12.16 percentage points and triad
WCSR by 8.11 points.

## Corpus and method

- GuitarSet 1.1.0, all 180 mono-microphone accompaniment performances
- 5,484.22 seconds (91.40 minutes) of audio
- Performed chord annotation from each `*_comp.jams` file
- Duration-weighted `mir_eval` 0.8.2 chord metrics
- Boundary precision, recall, and F1 use a 0.5-second tolerance
- ChordMini revision `fbd620e6a7617bbc82795b1f0c828a7721c213f4`
- ONNX SHA-256 `9a6570bf611cdc3f2c36286307af46fb94927fe7f6a2bc22a87c0ebf5f6c082e`

The GuitarSet performed-chord annotations are sheet-informed: their
segmentation and roots were predetermined, then qualities were derived using
separate-string note transcriptions and manually verified. This is a useful,
reproducible guitar benchmark, not a substitute for evaluation on full
commercial mixes.

## Duration-weighted results

| Metric | ChordMini | librosa baseline | Difference |
|---|---:|---:|---:|
| Root WCSR | 72.17% | 67.66% | +4.51 pp |
| Maj/min WCSR | 71.82% | 59.67% | +12.16 pp |
| Triads WCSR | 52.13% | 44.02% | +8.11 pp |
| Sevenths WCSR | 64.61% | 46.18% | +18.43 pp |
| MIREX WCSR | 69.57% | 54.81% | +14.76 pp |
| Segmentation | 79.96% | 64.51% | +15.45 pp |
| Boundary F1 | 66.29% | 43.37% | +22.92 pp |

ChordMini boundary precision/recall were 56.36% and 87.74%. The baseline was
29.33% and 96.89%, showing that its higher recall came from substantial
over-segmentation.

## Per-track distribution

| Metric | ChordMini Q1 | Median | Q3 | librosa Q1 | Median | Q3 |
|---|---:|---:|---:|---:|---:|---:|
| Root | 54.10% | 81.41% | 93.12% | 47.68% | 72.61% | 88.42% |
| Maj/min | 54.05% | 82.36% | 94.81% | 38.44% | 63.81% | 82.60% |
| Triads | 19.78% | 54.86% | 80.09% | 16.46% | 40.72% | 67.53% |
| Sevenths | 34.76% | 74.68% | 92.08% | 0.00% | 46.49% | 78.11% |
| MIREX | 48.25% | 75.65% | 91.39% | 31.33% | 55.51% | 76.44% |
| Segmentation | 71.24% | 83.42% | 91.90% | 51.70% | 66.25% | 75.21% |
| Boundary F1 | 50.00% | 69.29% | 85.71% | 32.26% | 43.17% | 54.55% |

Some tracks score zero for rich-vocabulary comparisons. The duration-weighted
coverage of references representable by ChordMini’s 14-quality vocabulary is
66.33% (per-track median 75.00%). Review-first editing remains necessary.

## Runtime and package delta

After model warm-up, the complete ChordMini run took 7.50 seconds for 91.40
minutes of audio, a measured real-time factor of 0.00137 on the benchmark Mac.
The transparent librosa baseline took 9.24 seconds. Total wall time, including
evaluation and report generation, was 18.99 seconds.

The model is 9,604,664 bytes. The installed ONNX Runtime package occupies
70,605,101 bytes, for an uncompressed installed delta of 80,209,765 bytes.
The downloaded macOS arm64 ONNX Runtime wheel is about 17.6 MiB; installed size
is reported because it more closely represents the application bundle cost.
The existing librosa baseline adds no package bytes.

## Reproduction

Keep GuitarSet outside Git, verify the mono-mic archive MD5
`275966d6610ac34999b58426beb119c3`, then run:

```sh
PYTHONPATH=server uv run --no-project python \
  scripts/chord_recognition_benchmark.py \
  --annotations .benchmarks/guitarset/data \
  --audio .benchmarks/guitarset/data \
  --output .benchmarks/guitarset/chord-results.json
```

The JSON result includes every per-track score and stays outside Git. The
checked-in report contains only aggregate evidence.
