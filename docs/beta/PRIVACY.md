# Privacy notice

The SoloTrace macOS app stores projects locally in the current macOS user
account. The desktop app has no accounts, telemetry, analytics, billing, or
automatic updater.

The separate hosted SoloTrace studio uses browser-local storage for unsaved
work. If a user signs in and explicitly saves a copy, the document is stored in
Cloudflare D1. Hosted Studio does not accept or process personal audio.

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
