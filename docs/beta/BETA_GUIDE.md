# SoloTrace private beta guide

SoloTrace is a private macOS 14+ beta for Apple Silicon. It runs as one local
app. No SoloTrace account or hosted SoloTrace service exists.

## Install and update

1. Quit SoloTrace.
2. Open the DMG and drag `SoloTrace.app` to Applications.
3. Replace the older app when Finder asks.
4. Open SoloTrace from Applications.

Projects remain in `~/Library/Application Support/SoloTrace`; replacing the app
does not remove that folder. Updates are manual.

Ad-hoc developer builds are for the developer Mac only. External testers must
receive a Developer ID signed and notarized DMG.

## Create a draft

- Choose **Audio file** for an existing recording, or **YouTube link** for one
  video you have permission to download and process. YouTube import is available
  only in the native macOS app and supports videos up to 30 minutes and 250 MB.
- Anonymous YouTube access is most private. Signed-in Chrome or Safari may help
  with account-accessible videos. SoloTrace remembers that choice, but never
  stores or exports browser cookies. Close the selected browser if macOS prevents
  cookie access, or fall back to a local audio file.
- The first YouTube import requires a rights and terms acknowledgement. This is
  remembered locally; every later import shows a short reminder. DRM, private,
  member-only, or otherwise inaccessible videos may still fail.
- SoloTrace transcribes the full song by default. Enable **Limit to a section**
  only when you want to drag a smaller range on the waveform.
- **Offline preview** stays on the Mac and remains available without a key or
  network connection. It accepts any song allowed by the importer.
- **Experimental MVSep lead estimate** uploads only the range selected for that
  run and supports at most 10 minutes. It requires a tester-owned MVSep key and
  a new rights/consent check for every run.

The result is an editable estimate. Check uncertain notes against the recording.

## Review a draft

Choose **Review · N remaining** to work through uncertain notes and unreviewed
chords in time order. SoloTrace loops 0.75 seconds around the current item and
uses lead audio when available. Finishing restores the prior loop and track.

- `J` / `K`: previous / next
- `A`: accept and advance
- `Space`: play / pause
- `Command-Z`: undo
- `Shift-Command-Z`: redo

These shortcuts stay inactive while you type in a form field. Save, delete, and
unknown actions also advance automatically. The reason beside each item names
what needs checking: pitch, timing, fingering, technique, or chord uncertainty.

## Back up, restore, and remove projects

Export `SoloTrace bundle` to preserve every tab version and declared audio.
Use `Import SoloTrace project` to restore a `.solotrace.zip` bundle. A corrupt
bundle is rejected before the library changes.

Moving a project to Trash is reversible. Permanent deletion asks for
confirmation, then removes its database records and local media.

## Diagnostics

`Save redacted diagnostics` writes a ZIP chosen by you. It includes app/build
versions, macOS details, capability booleans, database integrity, failure codes,
and recent SoloTrace logs. It excludes audio, notes, filenames, project
metadata, YouTube URLs, downloader output, and secrets. SoloTrace sends no telemetry.

## Roll back

Quit SoloTrace, replace the app with the prior notarized build, and reopen it.
Do not delete the Application Support folder. If a database migration fails,
contact the developer before retrying; timestamped pre-migration database
backups are stored in the `backups` subfolder.
