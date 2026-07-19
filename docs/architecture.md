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

## One future model seam

Separation is the first justified future adapter boundary because local and cloud
implementations return meaningfully different stems. The shipped path stays
direct—preview separation plus pYIN—until an optional worker is installed and
actually wired. Capabilities report only the path the pipeline can run.

Current built-in preview uses center-focused harmonic filtering. Its output is
labeled `preview`. A guitar separator must label output `all-guitar` unless it
can prove that rhythm guitar remains.

## URL import deferred

The first release accepts local files. Server-side URL fetching would introduce
SSRF controls, downloader upkeep, YouTube terms, copyright ambiguity, and
surprising network transmission. None helps answer whether the editor and
transcription are useful.
