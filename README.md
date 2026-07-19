# SoloTrace

SoloTrace turns a recorded guitar solo into a synchronized, editable tab and a
practice backing track. It is local-first: songs stay on this machine, the app
opens with a generated demo, and no account or API key is required.

The honest product promise is **accurate notes with playable, editable
fingerings**. Audio rarely reveals which of several equivalent string and fret
positions a guitarist used.

## What works

- Import common audio formats and mark the solo on a waveform.
- Create a local transcription draft with exact audio times and score times.
- Switch between full mix, estimated lead, and backing audio without losing position.
- Edit string, fret, timing, pitch, technique, and confidence per note.
- Regenerate only the fingering as balanced, easiest, or position-focused.
- Loop a passage and slow playback while preserving pitch.
- Export native project JSON, MusicXML 4.0, MIDI, ASCII tab, or a ZIP with audio.
- Start instantly with the exact-stem `Northbound Lights` synthetic demo.

The built-in upload pipeline currently uses a rough, fully local preview:
frequency-focused separation plus librosa pYIN transcription. Optional MLX
separation and Basic Pitch workers are the next adapter layer. The UI labels
preview stems honestly because frequency filtering is not lead-only separation.

## Architecture

```mermaid
flowchart LR
  UI["React tracing table"] --> API["FastAPI local service"]
  API --> DB["SQLite revisions"]
  API --> MEDIA["Project audio files"]
  API --> PIPE["Single local pipeline"]
  PIPE --> SEP["Separation adapter"]
  PIPE --> NOTES["Pitch, rhythm, fingering"]
  NOTES --> DOC["Versioned tab document"]
  DOC --> UI
  DOC --> OUT["MusicXML / MIDI / bundle"]
```

One Python process owns orchestration and persistence. One React app owns the
editor. There is no Redis, cloud database, authentication layer, or required
service account. Integer audio frames are the synchronization truth; score ticks
are retained separately for notation.

## Run it

Requirements: macOS or Linux, FFmpeg, `uv`, `pnpm`, and `mise`.

```bash
mise run install
pnpm --dir web build
mise run server
```

Open <http://127.0.0.1:8765>. For live development:

```bash
# Terminal 1
mise run api

# Terminal 2
mise run web
```

The Vite app runs at <http://127.0.0.1:5173> and proxies `/api` and `/media` to
the Python service.

To build an installable wheel, build the web app first. Hatch bundles the
generated assets into the wheel; `web/dist` remains ignored in the checkout.

```bash
pnpm --dir web build
uv build --wheel
```

## Verify it

```bash
mise run check
mise run smoke-wheel
```

Tests focus on the parts that protect real work: fingering legality, revision
conflicts, parseable exports, exact demo stems, media range requests, and the
production build.

## Processing model

The shipped draft path is intentionally deterministic and account-free:

1. Center-focused harmonic preview separation.
2. librosa pYIN, onset, and beat estimation.
3. Playability optimization across legal string/fret positions.
4. Manual synchronized correction.

Two stronger local upgrades were tested on this Mac but are not silently selected:
Demucs-MLX `htdemucs_6s` for all-guitar separation and Basic Pitch CoreML for
note/bend transcription. They require separate Python environments and about
105 MB of first-run model cache. See
[`docs/model-evaluation.md`](docs/model-evaluation.md) for verified commands,
limitations, and the open product choice.

## Project data

Runtime data uses the private per-user application-data directory
(`~/Library/Application Support/SoloTrace` on macOS, the XDG data directory on
Linux). Set `SOLOTRACE_DATA_DIR` to override it.

```text
SoloTrace/
├── solotrace.sqlite3
└── projects/
    └── <project-id>/
        ├── original.wav
        ├── lead-run-<id>.wav
        └── backing-run-<id>.wav
```

Generated proposals and user edits receive distinct revisions. A stale editor
gets HTTP `409` instead of silently overwriting a newer revision.
Data/project directories are created owner-only; the SQLite file is owner-readable
and owner-writable.

## Copyright and privacy

Import audio you are allowed to process. SoloTrace does not fetch YouTube URLs:
local URL downloading adds platform-terms, copyright, and server-side request
risks without improving the transcription core. A future desktop-only importer
can be evaluated separately.

The bundled demo is synthesized locally and contains no third-party recording.
