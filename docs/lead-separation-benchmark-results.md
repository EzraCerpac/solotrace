# Lead-guitar separation benchmark

Run 2026-07-20 on an Apple M5 Pro MacBook Pro with 24 GB unified memory.

## Decision

Use **MVSep Lead/Rhythm one-stage** as SoloTrace's default experimental
separator. On the shared stress-test case it produced the best downstream
transcription (`F1 = 0.690`), the best lead waveform score (`6.43 dB SI-SDR`),
and the best backing track (`8.87 dB SI-SDR`). Only `0.72%` of its source
projection energy came from the simultaneous rhythm guitar.

Keep **MVSep Lead/Rhythm two-stage** as an alternate. It was slightly more
conservative about rhythm leakage (`0.21%`) but lost more lead detail
(`F1 = 0.661`, `2.16 dB` lead SI-SDR).

Do not use a generic guitar stem as the transcription input when lead and
rhythm play together. The best generic extractors retained about one third of
the rhythm guitar and consequently produced hundreds of false note events.

## Why there are two scoreboards

These systems solve different problems:

- **Role-aware:** return the foreground lead guitar while rejecting another
  guitar.
- **All-guitar:** return guitar while rejecting drums, bass, keys, and other
  instruments.

An all-guitar model is successful when it returns both lead and rhythm. That is
the wrong behavior for SoloTrace's lead tab and backing track, so all-guitar
models are not ranked as product winners.

## Shared-case results

Every row below used the same 30-second `duet-01` mixture and the same exact
lead-note ground truth. Higher note F1 and SI-SDR are better; lower rhythm
leakage is better. Note F1 requires exact MIDI pitch and onset within 50 ms.

### Role-aware or prompted lead candidates

| Route | Note F1 | Lead SI-SDR | Rhythm leakage | Backing SI-SDR | Result |
|---|---:|---:|---:|---:|---|
| MVSep Lead/Rhythm one-stage | **0.690** | **6.43 dB** | 0.72% | **8.87 dB** | Default experiment |
| MVSep Lead/Rhythm two-stage | 0.661 | 2.16 dB | **0.21%** | 5.07 dB | Conservative alternate |
| SAM-Audio guided | 0.190 | -4.20 dB | 56.98% | -2.76 dB | Reject |
| SAM-Audio text only | 0.171 | -7.30 dB | 75.35% | -2.65 dB | Reject |
| AudioSep text only | 0.110 | -12.48 dB | 90.52% | -1.54 dB | Reject |

The SAM-Audio anchor improved the target, but not enough to resolve two guitars
by musical role. Its generated target and residual also reconstructed the input
less exactly (`13.2 dB` mixture consistency) than MVSep's returned stems.
AudioSep largely selected the rhythm guitar despite the `lead electric guitar`
prompt.

### General guitar extractors

| Route | Note F1 | Lead SI-SDR | Rhythm leakage | Backing SI-SDR | Local separator time |
|---|---:|---:|---:|---:|---:|
| MVSep BS-RoFormer SW | **0.396** | 2.71 dB | 34.37% | 1.87 dB | Cloud |
| Local BS-RoFormer SW, 699 MB | 0.390 | **2.75 dB** | **34.21%** | **2.87 dB** | 37.47 s / 4 cases |
| Banquet audio query | 0.375 | 0.48 dB | 37.39% | 2.20 dB | 619 s |
| MVSep Mel-RoFormer | 0.304 | -0.22 dB | 44.43% | 0.08 dB | Cloud |
| MVSep BS + Mel ensemble | 0.220 | -4.07 dB | 68.25% | -1.22 dB | Cloud |
| HTDemucs 6s MLX | 0.157 | -6.63 dB | 71.32% | -0.56 dB | **7.04 s / 4 cases** |

The large local BS-RoFormer is the best self-hosted **all-guitar** extractor
tested. It is much stronger than HTDemucs, but its public checkpoint declares no
usable weight license and it cannot distinguish lead from rhythm. It remains a
research baseline, not a shippable default.

The MVSep ensemble underperformed its individual BS model on this case. This is
not a transcription bug: its output projection actually contained more rhythm
than lead.

## Benchmark construction

The test uses publicly licensed EGSet12 performances (CC BY 4.0), whose JAMS
annotations and Guitar Pro files provide exact notes and tablature. Four lead
tracks (`01`, `02`, `07`, `12`) were mixed with:

1. the existing deterministic non-guitar backing;
2. independent polyphonic guitar track `06`, shifted per case;
3. rhythm RMS fixed to `0.72 ×` the lead RMS.

This is intentionally harder than the old one-guitar benchmark. It gives exact
lead, rhythm, other, mixture, and backing references, but it is still a
controlled role test—not a substitute for licensed studio multitracks.

Local HTDemucs and BS-RoFormer were run across all four cases. Service and very
slow research models were run on the shared `duet-01` case. Therefore use the
shared-case tables for cross-model comparison; the four-case aggregate only
checks local-model stability.

## Execution notes

- MVSep guest jobs returned 320 kbps MP3. Codec loss depresses absolute waveform
  scores slightly; downstream note scoring remains the product-relevant check.
- SAM-Audio Small used the 1.2 GB FP16 MLX conversion. Text-only inference took
  92.38 seconds including compilation. The cached guided run took 11.47 seconds.
- AudioSep used its complete official CPU path: the 1.26 GB separator, 2.35 GB
  CLAP encoder, and roughly 501 MB RoBERTa model. After repairing its legacy
  Linux/CUDA dependency lock, inference took 28.39 seconds.
- Banquet used its official 645.5 MB checkpoint and a 10-second guitar query
  from a different EGSet12 performance. Its official CPU code rejected a
  30-second input because reflection padding exceeded the signal length, so the
  mixture was repeated to 60 seconds and the first 30 seconds of output scored.
- HTDemucs and BS-RoFormer used native Apple acceleration. Banquet's official
  path used CPU.
- Native backing stems were scored where provided. Otherwise the benchmark used
  sample-aligned `mixture - target`.

## Access and licensing

| Candidate | Status | Product implication |
|---|---|---|
| Music AI Guitar Parts | Not run: dashboard now requires enterprise access | Revisit only if commercial access is obtained |
| MVSep | Ran through guest web UI | Best current prototype backend; automate with an API plan |
| Local BS-RoFormer SW | Ran; checkpoint license unknown | Research only |
| SAM-Audio MLX | Ran; Meta SAM License | Experimental fallback only |
| AudioSep | Ran; no separate checkpoint license found | Research only; poor role separation |
| Banquet | Ran; weights CC BY-NC-SA 4.0 | Research only |
| SCNet | No released guitar target | Architecture candidate for future training |
| CodecSep | No official code/checkpoint | Watchlist |

## Reproduce

Prepare the controlled mixtures:

```sh
.workers/separate/bin/python scripts/lead_separation_benchmark.py prepare
```

Add separator outputs to `.benchmarks/lead-separation/routes.json`, then score
waveforms and downstream Basic Pitch notes:

```sh
.workers/separate/bin/python scripts/lead_separation_benchmark.py score
```

Raw machine-readable results are written to
`.benchmarks/lead-separation/results.json`.
