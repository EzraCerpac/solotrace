# Architecture decisions

## Local monolith

SoloTrace uses one local FastAPI service, SQLite, ordinary media files, and one
React client. This is enough for one musician on one machine. Splitting the app
into services would add deployment and failure modes without improving model
quality.

## Two clocks

Every note keeps performance time as integer audio frames and notation time as
score ticks. The editor follows performance time; MusicXML and MIDI use notation
time. Sync anchors connect both. Quantization never destroys the original onset.

## Versioned tab document

Generated output is a proposal. User changes make a new revision. Updates include
the revision they started from; stale updates fail with `409`. Regeneration can
therefore never silently erase repairs.

## One model seam

Separation is the only network boundary. The selected route is MVSep's
role-aware one-stage Lead/Rhythm model; it returns a foreground lead estimate,
while backing is created locally as original minus lead. Spotify Basic Pitch,
beat mapping, fingering, persistence, editing, and export remain local.

Capabilities expose MVSep only when both its Keychain/environment token and the
local Basic Pitch worker are available. Otherwise the app falls back to its
center-focused preview and pYIN. MVSep output is labeled `solo-guitar`; preview
output remains labeled `preview`.

Each cloud request carries explicit user consent. MVSep polling runs inside the
existing single-worker pipeline and supports cancellation, so no second queue,
database, or service is needed.

## URL import deferred

The first release accepts local files. Server-side URL fetching would introduce
SSRF controls, downloader upkeep, YouTube terms, copyright ambiguity, and
surprising network transmission. None helps answer whether the editor and
transcription are useful.
