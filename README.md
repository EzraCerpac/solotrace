# SoloTrace

SoloTrace turns a recorded guitar solo into a synchronized, editable tab and a
practice backing track. It opens with a generated demo, and projects remain in a
private local library.
Lead separation is cloud-assisted through MVSep; transcription and editing stay
local.

The honest product promise is **accurate notes with playable, editable
fingerings**. Audio rarely reveals which of several equivalent string and fret
positions a guitarist used.

## What works

- Import common audio formats and transcribe the whole lead or a marked passage.
- Create a local transcription draft with exact audio times and score times.
- Switch between full mix, estimated lead, and backing audio without losing position.
- Edit string, fret, timing, pitch, technique, and confidence per note.
- Regenerate only the fingering as balanced, easiest, or position-focused.
- Loop a passage and slow playback while preserving pitch.
- Export native project JSON, MusicXML 4.0, MIDI, ASCII tab, or a ZIP with audio.
- Start instantly with the exact-stem `Northbound Lights` synthetic demo.

Uploaded songs use one selected route:

- **MVSep one-stage Lead/Rhythm:** foreground lead separation in MVSep's Germany
  cloud region, followed by local Spotify Basic Pitch note and bend transcription.
- **Offline fallback:** frequency-focused separation plus librosa pYIN, used only
  when the MVSep token or Basic Pitch worker is unavailable.

Every cloud run requires explicit confirmation that the user has rights to the
audio. Only the selected range is uploaded.

## Architecture

```mermaid
flowchart LR
  UI["React tracing table"] --> API["FastAPI local service"]
  API --> DB["SQLite revisions"]
  API --> MEDIA["Project audio files"]
  API --> PIPE["Single processing pipeline"]
  PIPE --> SEP["MVSep lead separation"]
  PIPE --> NOTES["Pitch, rhythm, fingering"]
  NOTES --> DOC["Versioned tab document"]
  DOC --> UI
  DOC --> OUT["MusicXML / MIDI / bundle"]
```

One Python process owns orchestration and persistence. One React app owns the
editor. There is no Redis, cloud database, or application login. Integer audio
frames are the synchronization truth; score ticks are retained separately for
notation.

## Run it

Requirements: macOS or Linux, FFmpeg, `uv`, `pnpm`, and `mise`.

```bash
mise run install
mise run install-models
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

On macOS, SoloTrace reads the MVSep token from Keychain service
`com.solotrace.mvsep`, account `solotrace`. Store or replace it without exposing
it in shell history:

```bash
security add-generic-password -a solotrace -s com.solotrace.mvsep -U -w
```

On Linux, set `SOLOTRACE_MVSEP_API_TOKEN`.

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

The full lead path is:

1. MVSep one-stage Lead/Rhythm separation for the whole song or marked passage.
2. Local Spotify Basic Pitch polyphonic note and bend estimation.
3. librosa beat estimation while retaining exact audio timestamps.
4. Playability optimization across legal string/fret positions.
5. Manual synchronized correction.

The UI selects MVSep automatically when both its token and the Basic Pitch worker
are available. Free MVSep accounts allow one concurrent API job, lossless 16-bit
WAV output, and inputs up to 10 minutes. The local Basic Pitch worker uses about
400 MB.
See [`docs/lead-separation-benchmark-results.md`](docs/lead-separation-benchmark-results.md)
for the separator decision and
[`docs/model-benchmark-results.md`](docs/model-benchmark-results.md) for the
12-song transcription evaluation.

## Project data

Runtime data uses the private per-user application-data directory
(`~/Library/Application Support/SoloTrace` on macOS, the XDG data directory on
Linux). Set `SOLOTRACE_DATA_DIR` to override it.

The transcription worker defaults to `.workers` in a source checkout. Set
`SOLOTRACE_WORKER_DIR` when starting an installed wheel from elsewhere.

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

Import and upload only audio you are allowed to process. Project metadata,
edits, and exported tabs remain local. A confirmed cloud run sends the selected
audio range to MVSep's Germany region and downloads a lossless lead stem; see
MVSep's privacy policy and terms before use.

SoloTrace does not fetch YouTube URLs:
local URL downloading adds platform-terms, copyright, and server-side request
risks without improving the transcription core. A future desktop-only importer
can be evaluated separately.

The bundled demo is synthesized locally and contains no third-party recording.
