# Dependency security triage

Checked against GitHub Dependabot and `pnpm audit` on 2026-07-27.

## Packaging gate

- Production paths had three PostCSS advisories and one Sharp/libvips advisory.
  The workspace overrides both transitive dependencies to patched releases:
  PostCSS 8.5.18 and Sharp 0.35.0.
- `setuptools` remains pinned to 80.9.0. Basic Pitch 0.4.0 still reaches
  `pkg_resources`; setuptools 83 removes it and breaks offline transcription.
  This accepted exception must remain visible until Basic Pitch removes that
  dependency or SoloTrace replaces the worker.
- Remaining GitHub alerts are development-tool paths. Recheck `pnpm audit`,
  GitHub Dependabot, the full hosted build, and the packaged Basic Pitch worker
  before creating a release artifact.

Code scanning has no configured analysis, and secret scanning is disabled for
this repository. Those are repository-configuration gaps, not clean scans.
