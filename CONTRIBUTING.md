# Contributing to SoloTrace

SoloTrace is open source under Apache-2.0. Contributions are accepted through
GitHub pull requests and are licensed under the same terms. Never publish tester
audio, project bundles, diagnostics, credentials, or other private data.

## Development setup

Requirements: Python 3.11, `uv`, `pnpm`, `mise`, and FFmpeg.

```bash
mise run install
mise run install-models
mise run check
mise run smoke-wheel
```

Use `mise run api` and `mise run web` for live development. Keep runtime data
outside the checkout with `SOLOTRACE_DATA_DIR`. Never commit `.env`, MVSep keys,
audio, project databases, diagnostics, build output, or signing material.

## Changes

- Create a `wip/...` bookmark or branch. Do not work directly on `main`.
- Keep changes small and explain user impact.
- Add focused tests for new risk; avoid duplicating implementation details in tests.
- Run `mise run check` and the smallest relevant smoke test.
- Update `CHANGELOG.md` for tester-visible behavior.
- Open a pull request. CI must pass before merge.

Use Jujutsu locally if preferred; GitHub still receives ordinary Git commits and
branches. Keep commit messages short and imperative.

## Reports

Use the issue templates for bugs and focused feature requests. Security problems
must follow [`SECURITY.md`](SECURITY.md). Attach only SoloTrace's redacted
diagnostic export, and inspect it before upload.
