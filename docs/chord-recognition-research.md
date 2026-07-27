# Chord recognition research

Status: implementation decision, 2026-07-27.

SoloTrace ships local ChordMini inference and keeps every detected chord in a
review-first, version-local `ChordTrack`. Recognition is evidence, not truth:
all detected spans begin unreviewed, scores are shown as model scores rather
than calibrated probabilities, and user edits are never overwritten.

## Decision

| Option | Evidence and strengths | Risks and costs | Decision |
| --- | --- | --- | --- |
| [ChordMini 2E1D ONNX](https://huggingface.co/musetric/chordmini-onnx) | 170 labels; 9.6 MB model; CPU inference; model repository declares MIT inherited from upstream weights | Young community export; no automatic inversion detection; published results are not directly comparable to SoloTrace’s input and benchmark | Ship, pinned and independently benchmarked |
| [librosa chroma CQT](https://librosa.org/doc/latest/generated/librosa.feature.chroma_cqt.html) | Already in SoloTrace; transparent templates; no weights or added runtime | Simple major/minor vocabulary and weaker discrimination in dense audio | Non-shipping benchmark baseline |
| [ChordMini BTC / PyTorch](https://github.com/ptnghia-j/ChordMini) | Upstream implementation and a possible accuracy challenger | Much larger PyTorch runtime and harder desktop packaging | Defer |
| ChordFormer | Useful research direction | No verified deployable weights found | Do not ship |
| [Chordino](https://isophonics.net/nnls-chroma), [madmom](https://github.com/CPJKU/madmom_models), and [Essentia](https://essentia.upf.edu/reference/std_ChordsDetection.html) | Mature references and useful algorithm comparisons | GPL/noncommercial model terms, obsolete packaging, or licensing incompatible with the intended app distribution; Essentia offers separate commercial licensing | Do not ship |

The ChordMini paper is [arXiv:2602.19778](https://arxiv.org/abs/2602.19778).
Published paper scores remain contextual evidence only until reproduced through
SoloTrace’s exact preprocessing, model file, audio selection, vocabulary, and
metric implementation.

## Pinned artifact and lineage

- Hugging Face repository: `musetric/chordmini-onnx`
- exact repository revision: `fbd620e6a7617bbc82795b1f0c828a7721c213f4`
- `chordnet.onnx`: 9,604,664 bytes
- ONNX SHA-256: `9a6570bf611cdc3f2c36286307af46fb94927fe7f6a2bc22a87c0ebf5f6c082e`
- `config.json` SHA-256: `1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4`
- declared license: MIT, inherited from upstream ChordMini weights
- runtime: `onnxruntime==1.27.0`

This is a community ONNX export of one upstream checkpoint, not an official
release by the ChordMini authors. SoloTrace preserves that qualification,
source links, hashes, and attribution in the packaged model notice. Pinning
protects reproducibility and supply-chain integrity; it does not independently
prove the repository’s licensing claim.

## Exact inference contract

The checked-in configuration and model graph define:

- 22,050 Hz mono original polyphonic audio
- 144-bin CQT, 24 bins per octave, C1 minimum frequency
- 2,048-sample hop
- `log(abs(CQT) + 1e-6)`
- float32 windows shaped `[windows, 108, 144]`
- logits shaped `[windows, 108, 170]`
- uniform nine-frame logit smoothing before segmentation
- 12 roots × 14 qualities, plus `N` (no chord) and `X` (unknown)

The qualities are `min`, `maj`, `dim`, `aug`, `min6`, `maj6`, `min7`,
`minmaj7`, `maj7`, `7`, `dim7`, `hdim7`, `sus2`, and `sus4`. ChordMini does
not detect inversions. SoloTrace therefore allows a manual spelled bass while
keeping the detected root and quality engine-neutral.

Recognition reads the original mix because that matches the model assumption.
Five-minute chunks use one 108-frame model-window overlap. Cancellation is
checked between expensive stages, overlap frames are deduplicated, and a draft
is published only after the complete chord track is ready.

## Benchmark design

The shipping comparison uses the 180 GuitarSet mono-mic accompaniment
(`*_comp`) performances. Audio and annotations are downloaded from the
[GuitarSet 1.1.0 Zenodo record](https://zenodo.org/records/3371780) and kept
under ignored `.benchmarks/` storage.

The performed-chord annotation is used. Its own annotation rule says it is
chord-sheet-informed, uses predetermined chord segmentation and separate-string
note transcriptions, and was manually verified. This makes the benchmark useful
but easier than unconstrained full-song chord discovery. GuitarSet’s acoustic
solo-guitar mix is also narrower than SoloTrace’s eventual real-song inputs.

Scores come from [mir_eval’s chord metrics](https://mir-eval.readthedocs.io/latest/api/chord.html):
root, maj/min, triads, sevenths, MIREX weighted chord-symbol recall, and
segmentation. The report also includes boundary precision/recall/F1 at 0.5
seconds, vocabulary coverage, duration-weighted aggregates, per-track
distributions, runtime, and raw package-size delta.

The baseline uses librosa CQT chroma with transparent major/minor templates. It
is intentionally a benchmark control, not a hidden runtime fallback.

## Product and export implications

- Audio time is authoritative. Frames and score ticks are rebuilt when the
  server accepts an edited chord track.
- Spelling such as `C#` versus `Db` is preserved. Entry aliases such as `Cm`,
  `C-`, and `Cmin` normalize to one quality.
- `unknown` is not musical `N.C.`.
- Detected chords always start unreviewed; there is no arbitrary confidence
  threshold.
- Refingering copies chords unchanged.
- MusicXML uses the official
  [MusicXML 4 harmony model](https://www.w3.org/2021/06/musicxml40/tutorial/chord-symbols-and-diagrams/).
- MIDI remains note-only. ChordPro, voicings, lyrics, diagrams, transposition,
  capo processing, and songbook features are intentionally deferred.

The symbol vocabulary follows the general structure described by
[Harte et al.](https://ismir2005.ismir.net/proceedings/1080.pdf), while the
stored SoloTrace types remain explicit and engine-neutral.
