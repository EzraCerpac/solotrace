# Local model evaluation

SoloTrace keeps the smaller preview + pYIN path as an instant fallback. The
enhanced path uses separate Demucs-MLX and Basic Pitch workers and becomes the
default only when both are actually installed.

Install both:

```bash
./scripts/install-enhanced-models.sh
```

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

The first run downloads a 52 MB converted weight file on the tested machine.
The isolated worker environments use about 1.7 GB. The six outputs are drums,
bass, other, vocals, guitar, and piano. This is **all guitar**, not reliably the
solo guitar. SoloTrace subtracts that estimate from the original only inside the
marked passage. This keeps original and backing sample-aligned, but missed guitar
remains audible.

MLX needs access to the Apple Metal device. A sandboxed or headless macOS process
can fail with `No Metal device available`; a normal local app launch works.

## Transcription: Basic Pitch CoreML

Verified stack: Python 3.11, `basic-pitch==0.4.0`, `coremltools==9.0`, and
`setuptools==80.9.0`.

```bash
uv venv --python 3.11 .workers/transcribe
uv pip install --python .workers/transcribe/bin/python \
  basic-pitch==0.4.0 coremltools==9.0 setuptools==80.9.0
```

A generated 440 Hz tone produced one A4 event and 83 pitch-bend frames through
the CoreML model. SoloTrace adds the marked-passage offset to each returned
event and preserves the contour rather than using Basic Pitch's default 120 BPM
MIDI timing.

Keep this worker separate from Demucs. Demucs conversion currently resolves
`setuptools==83`, while Basic Pitch's current resampling dependency still needs
the `pkg_resources` module present in setuptools 80.

## Public benchmark decision

All 12 EGSet12 public electric-guitar solos were evaluated against their exact
per-string annotations. The controlled full-band mixture used a deterministic
non-guitar backing at 0.9 times the lead RMS.

- Enhanced Demucs + Basic Pitch: **0.666 note F1**
- Fast preview + pYIN: **0.215 note F1**
- Demucs separation: **8.69 dB median SI-SDR**
- Preview separation: **4.40 dB median SI-SDR**

This makes Demucs + Basic Pitch the default installed route. It was about
3.1 times better on note F1 and 7.5 times faster per track in this benchmark.
Tab F1 remained 0.218 because audio cannot fully determine string/fret choice;
the correction editor remains essential. See
[`model-benchmark-results.md`](model-benchmark-results.md) for all 12 routes and
[`public-benchmark-research.md`](public-benchmark-research.md) for source and
licensing details.

No cloud account or API key is needed.
