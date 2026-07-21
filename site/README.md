# SoloTrace Example Studio

Public Vinext/Sites edition of SoloTrace. It ships three immutable CC0 example
projects and performs editing, refingering, playback, and exports in the browser.
It does not accept uploads or run transcription/separation jobs.

## Local development

From the repository root:

```bash
pnpm install
pnpm dev:site
```

The site is one package in the root pnpm workspace. The framework-neutral
editor lives in `packages/editor`; the desktop React/FastAPI app remains
separate.

## Persistence and auth

- Public examples and browser-local drafts require no account.
- `/library`, `/projects/*`, and saved-project API writes require dispatch-owned
  Sign in with ChatGPT.
- D1 is bound as `DB`; R2 is intentionally disabled.
- Set secret environment variable `SOLOTRACE_OWNER_ID_SECRET` in Sites. The
  server stores only an HMAC owner ID, never a raw email address.
- Each owner may keep three documents, each at most 256 KiB.

Generate and inspect the D1 migration after changing `db/schema.ts`:

```bash
pnpm --dir site db:generate
```

## Static examples

Regenerate deterministic manifests, peaks, and aligned WAV stems with:

```bash
uv run python scripts/generate_hosted_examples.py
```

Generated project/audio provenance explicitly dedicates the synthetic material
to CC0 1.0. No key, network request, or runtime compute is involved.

## Checks

```bash
pnpm --dir packages/editor test
pnpm --dir site test
```

`pnpm --dir site build` must produce `dist/server/index.js` before packaging or
publishing through Sites.
