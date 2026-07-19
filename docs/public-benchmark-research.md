# Public benchmark research

## Recommendation

Use **EGSet12**, not a commercial YouTube song. It was created specifically to
evaluate guitar tablature transcription: twelve original solo electric-guitar
performances, each paired with a Guitar Pro tab and time-aligned JAMS
annotations. The official release is **CC BY 4.0**, so SoloTrace may download,
process, and redistribute derived benchmark results when it credits the
creators. The complete release is 110.5 MB.

Primary source: [official EGSet12 Zenodo record](https://zenodo.org/records/11406378).
The accompanying paper describes the pieces as original performances composed
for this project and treats their tabs as ground truth for both pitch and
string/fret metrics:
[Pedroza et al., DAFx 2024](https://arxiv.org/abs/2405.14679).

Start with track **02**, then run all twelve:

- [02.wav](https://zenodo.org/records/11406378/files/02.wav?download=1)
- [02.jams](https://zenodo.org/records/11406378/files/02.jams?download=1)
- [02.gp](https://zenodo.org/records/11406378/files/02.gp?download=1)
- [all files](https://zenodo.org/api/records/11406378/files-archive)

Track 02 is a useful smoke benchmark: 30.857 seconds, 140 BPM, and 242 annotated
notes spanning all six strings. Its JAMS file contains one `note_midi`
annotation per string, exact onset/duration values, and tempo. The `.gp` file is
the corresponding tablature source. These facts are directly inspectable in the
linked annotation and tab.

## Benchmark properties

| Property | EGSet12 |
| --- | --- |
| Performances | 12 original solo electric-guitar pieces |
| Duration | 31.65 seconds average; 379.8 seconds total |
| Recording | Sire T7 Telecaster through Yamaha B15 amplifier |
| Audio | 48 kHz WAV; duplicated stereo channels, effectively mono |
| Effects | Amplifier only; no added effects |
| Styles | Pop, funk, jazz, and twelve-tone |
| Techniques | Includes alternate picking, hybrid picking, and palm mute |
| Ground truth | Matching `.gp` tablature and per-string `.jams` note annotations |
| License | CC BY 4.0; attribution required |

All properties come from the
[official dataset description](https://zenodo.org/records/11406378) and
[authors' paper](https://ar5iv.org/html/2405.14679v3#S2.SS3).

## Evaluation matrix

Run every EGSet12 track through:

1. pYIN directly;
2. Basic Pitch directly;
3. the supplied TabCNN checkpoint directly;
4. Demucs `htdemucs_6s` guitar output followed by pYIN;
5. Demucs `htdemucs_6s` guitar output followed by Basic Pitch.

Score at least:

- note onset F1 and pitch F1;
- string/fret F1;
- tablature disambiguation rate: correct string/fret given correct pitch;
- median onset error;
- processing time.

Those pitch, tablature, and disambiguation metrics match the evaluation
definitions used by the
[EGSet12 paper](https://ar5iv.org/html/2405.14679v3#S2.SS4).

EGSet12 contains isolated guitar, so it cannot by itself measure backing-track
removal. For a controlled separation test, mix each EGSet12 WAV with a
deterministically generated non-guitar backing, retain both source files, and
compare Demucs' recovered guitar against the untouched EGSet12 source. Running
Demucs on isolated EGSet12 still measures preservation damage, but not
separation quality.

## Model status and licensing

### Demucs-MLX

[`demucs-mlx`](https://github.com/ssmall256/demucs-mlx) is an independent
Apple-Silicon port, not an official Meta or Apple package. Version 1.4.4 is
MIT-licensed, requires Python 3.10+, and fixes long-input overlap-add errors.
`htdemucs_6s` is the only listed model that adds `guitar` and `piano` to the
usual drums, bass, other, and vocals outputs.

Download only the
[`htdemucs_6s` converted weight](https://huggingface.co/mlx-community/demucs-mlx/tree/main);
it is about 105–110 MB. The full model repository is 6.72 GB because it contains
all converted Demucs variants. The MLX model card labels the converted weights
MIT and says they are direct, unmodified conversions. Upstream
[Demucs](https://github.com/facebookresearch/demucs) is also MIT, but is
archived and calls the six-source model experimental. Upstream does not state a
separate pretrained-weight license, so product notices should record that
small ambiguity rather than claiming more.

### Basic Pitch

[`spotify/basic-pitch`](https://github.com/spotify/basic-pitch) is Spotify's
Apache-2.0 implementation. The current published release is
[`0.4.0`](https://pypi.org/project/basic-pitch/), dated 2024-08-16. It is
instrument-agnostic and polyphonic, returns note events and pitch bends, and
explicitly works best on one instrument at a time. Input is downmixed to mono
and resampled internally to 22.05 kHz. This makes it the strongest ready-to-run
general transcription baseline after isolation, not a string/fret model.

### pYIN

SoloTrace's current
[`librosa.pyin`](https://librosa.org/doc/latest/generated/librosa.pyin.html)
path estimates one fundamental-frequency sequence plus voicing flags. It is a
valid monophonic lead baseline, but cannot represent simultaneous pitches in
EGSet12 chords. Librosa is
[ISC-licensed](https://github.com/librosa/librosa/blob/main/LICENSE.md).

### TabCNN supplied with EGSet12

The EGSet12 release includes a
[3.3 MB trained TabCNN checkpoint](https://zenodo.org/records/11406378/files/best_TabCNN_tablature_trancription_model?download=1).
The authors provide
[CC0 evaluation code and an EGSet12 inference script](https://github.com/robust-guitar-tabs/code).
Zenodo labels the deposit containing the checkpoint CC BY 4.0.
This is the only immediately runnable guitar-specific checkpoint found in the
benchmark's primary sources. Evaluate it; do not make it a production
dependency until its old research stack is isolated and reproducible.

## Candidates not ready for this run

`docs/model-evaluation.md` names no guitar-specific transcription model; it
names only pYIN, Demucs-MLX, and Basic Pitch. Other research candidates from the
product research are not equivalent drop-ins:

- [High-resolution guitar transcription](https://xavriley.github.io/HighResolutionGuitarTranscription/)
  publishes a paper and dataset, but no public inference repository or
  checkpoint.
- [FretNet](https://github.com/cwitkowitz/guitar-transcription-continuous) is
  MIT research code with training and inference examples, but no release or
  published checkpoint.
- [Timbre-Trap](https://github.com/sony/timbre-trap) is MIT and publishes base
  weights, but it is instrument-agnostic and produces pitch/note estimates, not
  string/fret tablature.

## Useful secondary benchmark

[GuitarSet v1.1](https://zenodo.org/records/3371780) remains useful for acoustic
generalization. It contains 360 roughly 30-second performances with per-string
pitch contours, MIDI notes, string/fret positions, beats, and chords. Its
official release is CC BY 4.0. Direct downloads:

- [annotations, 39.1 MB](https://zenodo.org/records/3371780/files/annotation.zip?download=1)
- [mono microphone audio, 656.9 MB](https://zenodo.org/records/3371780/files/audio_mono-mic.zip?download=1)

Prefer EGSet12 first because it matches SoloTrace's electric-solo target,
contains actual Guitar Pro tabs, was held out to test domain robustness, and is
small enough to run exhaustively.
