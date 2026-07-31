# Dependency security triage

Checked against GitHub Dependabot and `pnpm audit` on 2026-07-27.

## Packaging gate

- Production paths had three PostCSS advisories and one Sharp/libvips advisory.
  The workspace overrides both transitive dependencies to patched releases:
  PostCSS 8.5.18 and Sharp 0.35.0.
- Legacy ESLint paths resolve Brace Expansion 5.0.8. The full lint and build
  suite passes with the patched release.
- Basic Pitch 0.4.0 caps Resampy below 0.4.3, whose resource-loading migration
  is required by Setuptools 83. SoloTrace overrides that stale cap, ships
  Resampy 0.4.3 and Setuptools 83.0.0, and verifies the exact CoreML worker with
  generated audio during packaging.
- These choices resolve the known advisories as of this review. GitHub continues
  to report the default branch until the fixes are integrated. Recheck
  `pnpm audit`, Dependabot, the full hosted build, and the packaged Basic Pitch
  worker before creating a release artifact.

Code scanning has no configured analysis, and secret scanning is disabled for
this repository. Those are repository-configuration gaps, not clean scans.
