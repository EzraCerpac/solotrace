# Lead-guitar separation: runnable-model audit

Checked 2026-07-20 against first-party API documentation, official repositories, and model cards. The test machine is an Apple M5 Pro MacBook Pro with 24 GB unified memory.

## Decision

The approaches that can be benchmarked honestly now are:

1. **MVSep Lead/Rhythm Guitar**: the most direct role-aware API candidate.
2. **Music AI Guitar Parts**: the other direct role-aware API candidate.
3. **MVSep Guitar with BS-RoFormer and Mel-RoFormer variants**: the practical way to test those architectures with guitar checkpoints.
4. **SAM-Audio Small, MLX conversion**: the best promptable local Apple-Silicon experiment.
5. **Banquet**: a local audio-query baseline; CPU-only in its official inference path on this Mac.
6. **AudioSep**: an older text-query baseline; CPU-only and awkward to install on modern macOS.
7. **HTDemucs `htdemucs_6s` through demucs-mlx**: the fast, already-working all-guitar baseline.

Do **not** count SCNet or CodecSep as attempted models: neither currently has a public checkpoint that can produce a guitar target through its official release. Likewise, public BS-/Mel-Band RoFormer repositories expose the architecture, but their clearly licensed checkpoints are generally vocal or four-stem models, not lead guitar.

One benchmark limitation matters: the original EGSet12 controlled mixtures contain one
guitar source plus generated non-guitar accompaniment. They are valid for all-guitar
extraction, but not lead-versus-rhythm separation. The implemented comparison therefore
adds an independent polyphonic EGSet12 performance as the rhythm-guitar reference. This
creates exact role labels and exposes guitar leakage, while remaining a controlled stress
test rather than a claim about real studio multitracks.

## Availability matrix

| Approach | Target returned | Checkpoint/API access | License or service terms | M5 Pro / 24 GB status | EGSet12 decision |
|---|---|---|---|---|---|
| Music AI Guitar Parts | `solo_guitars`, `rhythm_guitars`, `other` | Enterprise dashboard/API key/workflow | SaaS terms; evaluation output is internal-evaluation-only; users must hold input rights | Cloud; no local hardware constraint | **Blocked: no self-service access** |
| MVSep Lead/Rhythm | `lead-guitar`, `rhythm-guitar` | Guest web jobs work; API token needed for automation | SaaS terms; output use depends on rights to source | Cloud; no local hardware constraint | **Ran one- and two-stage** |
| MVSep Guitar RoFormers | `guitar`, `other` | Guest web jobs work; API token needed for automation | Same MVSep terms | Cloud | **Ran BS, Mel, and ensemble** |
| BS-/Mel-Band RoFormer local | Depends on checkpoint | Code and many weights public; no clearly licensed local lead/rhythm checkpoint | Code MIT; checkpoint licenses vary and one useful six-stem mirror is explicitly `unknown` | Framework selected MPS; 699 MB six-stem mirror ran | **Ran as research-only baseline** |
| SCNet | MUSDB18 vocals/drums/bass/other | Official standard and large checkpoints public | MIT | Official code is PyTorch; no guitar output | **Exclude** |
| SAM-Audio Small MLX | Prompted `target` and `residual` | Public MLX conversion; official Meta checkpoint is gated | Meta SAM License | Native MLX, 0.6B FP16, 1.2 GB weights | **Ran text and text+span prompts** |
| AudioSep | Text-prompted target | Public 1.26 GB checkpoint plus 2.35 GB CLAP checkpoint | Repo MIT; no separately stated weight license found | CPU; official Linux/CUDA environment needed repair | **Ran text prompt** |
| CodecSep | Text-prompted target in codec space | Paper only; no official code/checkpoint found | Not determinable without a release | Not runnable | **Exclude** |
| Banquet | Audio-query target | Public 645.5 MB recommended checkpoint | Code MIT; weights CC BY-NC-SA 4.0 | Official path used CPU, not MPS; 619 seconds | **Ran with leave-one-song-out guitar query** |
| HTDemucs 6s MLX | Combined `guitar` stem | Automatic public weight download | MIT | Native MLX; 105 MB weights | **Ran as fast baseline** |

No `MUSIC_AI_API_KEY`, MVSep token, or Hugging Face CLI login was present in this workspace when checked.

## Live access findings

- **Music AI could not be run.** Its current dashboard routes new users to
  "Get Enterprise access"; there is no self-service account/API-key flow to complete.
- **MVSep did run without an account through its public guest UI.** Guest output is
  320 kbps MP3, so downstream transcription is comparable but absolute waveform metrics
  include codec loss. Both Lead/Rhythm variants and the BS, Mel, and ensemble Guitar
  variants completed.
- **AudioSep's advertised 1.26 GB checkpoint is not its full runtime footprint.** The
  official path also requires a 2.35 GB CLAP checkpoint and a roughly 501 MB RoBERTa
  model. Its pinned Linux/CUDA environment needed several compatibility repairs on this
  Mac. The repaired CPU trial completed, but the prompt selected mostly rhythm guitar
  and scored only `0.110` note F1.

## Exact interfaces and caveats

### Music AI / Moises

The official [Guitar Parts module](https://music.ai/modules/stem-separation/guitar-parts/) accepts `inputFileUrl` and returns three URLs: `solo_guitars`, `rhythm_guitars`, and `other`. The broader Moises product defines lead guitar as melodies, riffs, and solos, which is close to the desired full-lead role ([official announcement](https://moises.ai/newsroom/product-announcements/new-guitar-separation-models/)).

API use requires an application key from the dashboard in the `Authorization` header. A job is an asynchronous `POST /v1/job` referencing a workflow slug, followed by polling `GET /v1/job/:id`; uploaded local files first obtain signed upload/download URLs ([authentication](https://music.ai/docs/api/authentication/), [API reference](https://music.ai/docs/api/reference/)). The Guitar Parts module costs $0.10 per input minute at current pay-as-you-go pricing ([pricing](https://music.ai/pricing/)).

This is a black-box service: there is no checkpoint, local runtime, or model license to inspect. The [service terms](https://music.ai/terms/) say evaluation access and its output are only for internal evaluation, prohibit using output to train ML models without written authorization, and require rights to uploaded content. That still permits this internal public-dataset benchmark.

Recommended run: process every controlled mix; score `solo_guitars` against the clean EGSet12 guitar, `rhythm_guitars + other` as backing, and also record how much energy incorrectly lands in `rhythm_guitars`.

### MVSep

MVSep exposes the most useful current benchmark surface in its official [full API](https://mvsep.com/en/full_api):

- `sep_type=101`, Lead/Rhythm Guitar. `add_opt1=0` selects the two-stage model; `1` selects one-stage. Outputs are `lead-guitar` and `rhythm-guitar`.
- `sep_type=31`, Guitar. `add_opt1=3` is Mel-RoFormer, `5` is a BS-RoFormer, `7` is BS-RoFormer SW, and `6` is the BS+Mel ensemble. Outputs are `guitar` and `other`.

Create jobs with multipart `POST https://de.mvsep.com/api/separation/create` using `audiofile`, `api_token`, `sep_type`, model options, and `output_format=4` for 32-bit WAV. Poll `GET /api/separation/get?hash=...`. The regional Germany endpoint is recommended for this location.

An account/API key is required for programmatic API use, but the live guest web flow
accepted these benchmark jobs without registration. The [plans page](https://mvsep.com/en/plans)
gives registered accounts limited API access, one concurrent job, 10-minute/100-MB files,
and 16-bit WAV/FLAC; premium credits give full API access and 32-bit WAV. Guest downloads
in this run were 320 kbps MP3. MVSep's [terms](https://mvsep.com/terms) require rights to
uploaded audio and allow commercial output use only when the source is not third-party
copyrighted.

Recommended runs: both `sep_type=101` variants, plus `sep_type=31` with Mel (`3`), BS SW (`7`), and ensemble (`6`). The role-aware output is the main candidate; the three general guitar models answer the user's request to test general-purpose architectures.

### Local BS-RoFormer and Mel-Band RoFormer

The [reference architecture repository](https://github.com/lucidrains/BS-RoFormer) is MIT and provides `BSRoformer` and `MelBandRoformer` PyTorch modules. It is an architecture package, not a ready guitar separator. The MVSep team's MIT [Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) framework provides folder inference:

```sh
python inference.py \
  --model_type bs_roformer \
  --config_path CONFIG.yaml \
  --start_check_point MODEL.ckpt \
  --input_folder inputs \
  --store_dir outputs
```

Its current inference code selects CUDA, then MPS, then CPU ([source](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/inference.py)). However, the framework's official [pretrained-model list](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md) primarily publishes vocal, four-stem, denoise, dereverb, and other-target checkpoints. It does not publish the MVSep lead/rhythm model. The tempting public six-stem `jarredou/BS-ROFO-SW-Fixed` model card declares its license **unknown** ([model card](https://huggingface.co/jarredou/BS-ROFO-SW-Fixed)).

Therefore the fair and legally clearer test is MVSep's named guitar RoFormer variants. Do not silently ship the unknown-license mirror.

### SCNet

The official [SCNet repository](https://github.com/starrytong/SCNet) is MIT, publishes standard and large MUSDB checkpoints, and runs:

```sh
python -m scnet.inference \
  --input_dir INPUT \
  --output_dir OUTPUT \
  --checkpoint_path CHECKPOINT.th
```

Those checkpoints implement MUSDB's vocals/drums/bass/other split. Guitar is folded into `other`, along with the controlled accompaniment, so there is no guitar estimate to score. SCNet is an architecture worth future lead/rhythm training, but its released checkpoint is not a lead-guitar approach.

### SAM-Audio

Meta's official [SAM-Audio repository](https://github.com/facebookresearch/sam-audio) supports text, positive/negative temporal anchors, and returns both `result.target` and `result.residual`. Official weights require accepting the gated model conditions and authenticating with Hugging Face. The official PyTorch example selects CUDA or CPU, not MPS.

For this Mac, the public [MLX Community SAM-Audio Small FP16 conversion](https://huggingface.co/mlx-community/sam-audio-small-fp16) is more practical: 0.6B parameters, 1.2 GB FP16 weights, `mlx-audio`, native Metal, and memory-efficient long-audio/chunked decoding. It inherits Meta's custom [SAM License](https://huggingface.co/facebook/sam-audio-small/blob/main/LICENSE), not an OSI license. The conversion card's sample mistakenly names `facebook/sam-audio-small-fp16`; the actual downloadable repository is `mlx-community/sam-audio-small-fp16`.

The core interface is:

```python
processor = SAMAudioProcessor.from_pretrained("mlx-community/sam-audio-small-fp16")
model = SAMAudio.from_pretrained("mlx-community/sam-audio-small-fp16")
batch = processor(
    audios=[mix_path],
    descriptions=["lead electric guitar"],
    anchors=[[('+', start_s, end_s)]],  # optional guidance
)
result = model.separate(
    audios=batch.audios,
    descriptions=batch.descriptions,
    sizes=batch.sizes,
    anchor_ids=batch.anchor_ids,
    anchor_alignment=batch.anchor_alignment,
    ode_decode_chunk_size=50,
)
```

Recommended prompt sweep: `electric guitar`, `lead electric guitar`, `melodic lead guitar`, and `electric guitar playing the foreground melody`; repeat the best prompt with a positive span. Do not use the clean reference stem as an audio prompt.

### AudioSep

The MIT [official repository](https://github.com/Audio-AGI/AudioSep) publishes `audiosep_base_4M_steps.ckpt` and a text-query interface:

```python
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = build_audiosep(
    config_yaml="config/audiosep_base.yaml",
    checkpoint_path="checkpoint/audiosep_base_4M_steps.ckpt",
    device=device,
)
inference(model, mix_path, "lead electric guitar", output_path, device, use_chunk=True)
```

The model runs at 32 kHz, its checkpoint is about 1.26 GB, and the official code has CPU fallback. The published environment is a Linux-oriented Python 3.10/CUDA 11.6 lockfile ([environment](https://github.com/Audio-AGI/AudioSep/blob/main/environment.yml)), so modern macOS installation needs dependency repair and receives no Metal acceleration. The repository does not state separate terms for the checkpoint beyond its MIT repository license; verify this before product distribution.

Recommended prompt sweep: the same text-only prompts as SAM-Audio. Backing must be reconstructed at the model's aligned 32-kHz rate because the official inference helper writes only the target.

### CodecSep

The official paper, [Neural Audio Codecs for Prompt-Driven Universal Source Separation](https://arxiv.org/abs/2509.11717), describes a DAC-latent text-conditioned separator and reports 1.35 GMAC in code-stream deployment. As of this audit, the paper exposes no official inference repository, model card, or checkpoint. It cannot be reproduced or compared fairly now.

### Banquet

The official MIT [Banquet repository](https://github.com/kwatcharasupat/query-bandit) provides audio-query inference and public weights. The recommended `ev-pre-aug.ckpt` is 645.5 MB; all released weights are [CC BY-NC-SA 4.0 on Zenodo](https://zenodo.org/records/13694558), so this is a research-only product candidate.

```sh
python train.py inference_byoq \
  --ckpt_path ev-pre-aug.ckpt \
  --input_path mix.wav \
  --output_path guitar.wav \
  --query_path independent-guitar-query.wav \
  --batch_size 1 \
  --use_cuda false
```

The official function requires a 10-second, 44.1-kHz query and explicitly chooses CUDA or CPU; it does not use MPS ([source](https://github.com/kwatcharasupat/query-bandit/blob/main/train.py)). The README says batch size 12 usually fits an RTX 4090, so batch size 1 on this 24-GB Mac is the conservative CPU trial.

For a fair EGSet12 score, use a clean 10-second guitar query from a **different** EGSet12 song for each target. Querying with the target's own clean stem would leak the answer.

### HTDemucs

The official Demucs release includes experimental `htdemucs_6s`, which returns drums, bass, other, vocals, guitar, and piano; its own README calls guitar quality merely “okay” ([official repository](https://github.com/facebookresearch/demucs)). Demucs and weights are MIT.

The MIT [demucs-mlx port](https://github.com/ssmall256/demucs-mlx) is the correct Apple-Silicon runtime. It provides native MLX/Metal inference, a 105-MB `htdemucs_6s` conversion, automatic resampling, and CLI/Python interfaces:

```sh
demucs-mlx -n htdemucs_6s -o outputs mix.wav
```

```python
separator = Separator(model="htdemucs_6s", shifts=1, seed=0)
origin, stems = separator.separate_audio_file("mix.wav")
lead_estimate = stems["guitar"]
```

This is fully runnable and should remain the latency/reference baseline, but it cannot distinguish lead from rhythm guitar.

## Fair comparison protocol

Use the same 12 EGSet12 controlled mixes, target gain, sample alignment, and metrics already used by the repository.

- Resample each returned target to the clean reference rate, then estimate and correct only integer sample latency. Do not allow arbitrary time warping.
- Report SI-SDR, scale-invariant correlation, and downstream Basic Pitch note F1. The note score should choose the product winner.
- Report mixture consistency: error between `mix` and `target + residual/backing`.
- For role-aware APIs, also report guitar energy placed in the rhythm output.
- Record wall time, upload/download time separately, peak memory locally, output sample rate, and any failed songs.
- Use a fixed prompt set for SAM-Audio/AudioSep and disclose prompt selection. Select the prompt on a small development subset, not independently per test song.
- Use one leave-one-song-out 10-second guitar query for Banquet.

The controlled set can select the best **guitar extractor**. It cannot justify a claim of best **lead-versus-rhythm separator**. That requires mixtures containing both reference lead and reference rhythm stems.
