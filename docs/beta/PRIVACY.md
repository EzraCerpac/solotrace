# Privacy notice

SoloTrace stores projects locally in the current macOS user account. It has no
accounts, telemetry, analytics, billing, hosted backend, or automatic updater.

Offline preview, transcription, fingering, editing, playback, exports, and
diagnostic generation run locally. A diagnostic bundle is saved only when the
tester asks and is not uploaded by SoloTrace.

If the tester explicitly selects the Experimental MVSep path and confirms
rights for that run, SoloTrace uploads only the chosen audio range to MVSep and
downloads the resulting lead estimate. The MVSep API key is stored in macOS
Keychain under service `com.ezracerpac.solotrace`; it is excluded from process
arguments, app logs, project exports, and diagnostics.

Testers should review MVSep's own terms and privacy policy before using its
service.
