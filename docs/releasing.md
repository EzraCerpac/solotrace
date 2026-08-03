# Releasing SoloTrace for macOS

SoloTrace ships as a manual private-beta DMG for macOS 14+ on Apple Silicon.
`pyproject.toml` is the only version source. A release is not complete until the
DMG is Developer ID signed, notarized, stapled, accepted by Gatekeeper, and
accompanied by a SHA-256 checksum.

## Prerequisites

- Apple Developer Program membership.
- A `Developer ID Application` certificate exported as a password-protected P12.
- An App Store Connect API key allowed to submit notarizations.
- A clean `main` commit with green CI.
- Changelog, beta guide, privacy notice, MVSep disclosure, third-party notices,
  and private-beta terms reviewed for the release.

Never commit certificates, API keys, passwords, provisioning profiles, or
notarization credentials.

## GitHub Actions secrets

Configure these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID P12 |
| `APPLE_CERTIFICATE_PASSWORD` | P12 export password |
| `APPLE_DEVELOPER_IDENTITY` | Full `Developer ID Application: ...` identity |
| `APPLE_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect `.p8` key |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_ISSUER_ID` | App Store Connect issuer UUID |

On macOS:

```bash
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE_P12_BASE64
base64 -i AuthKey_KEYID.p8 | gh secret set APPLE_NOTARY_KEY_BASE64
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_DEVELOPER_IDENTITY
gh secret set APPLE_NOTARY_KEY_ID
gh secret set APPLE_NOTARY_ISSUER_ID
```

Base64 is transport encoding, not encryption. GitHub stores the resulting values
as encrypted Actions secrets.

## Automated release

1. Set `project.version` in `pyproject.toml` and update `CHANGELOG.md`.
2. Merge to `main`; wait for `CI / quality`.
3. Open **Actions → Release macOS beta → Run workflow**.
4. Enter tag `v<project.version>`.
5. Wait for signing, notarization, stapling, Gatekeeper verification, and release
   publication.
6. Download the DMG and checksum from the GitHub prerelease.
7. Verify the checksum and perform the clean-Mac acceptance pass from the beta
   plan before inviting testers.

The workflow creates the tag at the exact tested commit and publishes a
prerelease only after all release checks pass.

The clean-Mac pass must install the DMG through Gatekeeper, open the generated
demo, import a local song, run Offline preview, review one note and one chord
without a pointer, enter Play mode, export and re-import a SoloTrace bundle,
then relaunch and confirm project persistence. With an authorized test video,
also verify anonymous, Chrome, and Safari YouTube import; playlist links with a
current video; invalid, private, over-30-minute, and offline failures; the
one-time rights acknowledgement; source reopening; and the 390 px layout. Never
make a live YouTube request in CI.

## Local release

The same release path can run on an enrolled Apple-Silicon Mac:

```bash
SOLOTRACE_CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
SOLOTRACE_NOTARY_PROFILE="solotrace" \
mise run release-macos
```

Output:

```text
dist/release/SoloTrace-<version>-macOS-arm64.dmg
dist/release/SoloTrace-<version>-macOS-arm64.dmg.sha256
```

Ad-hoc `mise run package-macos` output is developer-only and must not be attached
to a tester release.
