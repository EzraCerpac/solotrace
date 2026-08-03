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

Each song project owns shared audio and a shelf of named tab versions. A version
owns its notes, fingering style, Beat Map, origin, timestamps, and review counts.
Generated output is a proposal: processing creates a new `Lead draft N`, a
whole-tab style action derives a new version, and Phrase Workshop derives an
honestly labeled mixed-style version. None overwrites an edited source.

Confidence is model evidence. `reviewed` is the musician's decision and is stored
separately on each note. Refingering preserves review state when a note stays on
the same string/fret and reopens it when that position moves.

All mutations include one project-wide revision token; stale updates fail with
`409`. SQLite persists projects, versions, reviews, selected sections, and
recoverable Trash state. Browser local storage only remembers workspace
preferences; playback position and note selection reset on reopen.

Beat Map edits are staged and then replace the active version's tempo, meter,
pickup phase, and sync anchors in one revision. Audio frames remain immutable;
note and chord score fields are regenerated from the new piecewise map. Derived
phrase versions inherit that corrected map, while sibling versions stay intact.

## One processing seam

Separation is the only processing network boundary. The selected route is MVSep's
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

## Desktop YouTube import boundary

The hosted studio never fetches URLs. The native macOS app may import one
strictly validated YouTube HTTPS video URL through its loopback-only API. URL
parsing accepts exact YouTube hosts and known video routes, then canonicalizes
the video ID before any process starts. Channels, searches, playlist-only URLs,
credentials, ports, and lookalike hosts fail closed.

A pinned `yt-dlp` executable and Deno runtime run directly without a shell,
user configuration, plugins, updates, remote components, playlists, or a
persistent cache. The process has a ten-minute timeout; downloaded data lives in
a private temporary directory and then enters the shared local FFmpeg import
helper. Optional Chrome or Safari cookies remain inside that process. SoloTrace
stores only the chosen browser preference and canonical source URL. Diagnostic
output redacts YouTube URLs and never includes raw downloader output.
