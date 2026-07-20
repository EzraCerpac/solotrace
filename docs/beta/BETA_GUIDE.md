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

- **Offline preview** stays on the Mac and remains available without a key or
  network connection.
- **Experimental MVSep lead estimate** uploads only the range selected for that
  run. It requires a tester-owned MVSep key and a new rights/consent check for
  every run.

The result is an editable estimate. Check uncertain notes against the recording.

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
metadata, and secrets. SoloTrace sends no telemetry.

## Roll back

Quit SoloTrace, replace the app with the prior notarized build, and reopen it.
Do not delete the Application Support folder. If a database migration fails,
contact the developer before retrying; timestamped pre-migration database
backups are stored in the `backups` subfolder.
