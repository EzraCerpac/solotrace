import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  EditorClientHttpError,
  HostedEditorClient,
} from "../lib/client/editor-client";

type FetchCall = {
  init?: RequestInit;
  url: string;
};

const SLUG = "northbound-lights";
const DRAFT_KEY = `solotrace:example-draft:${SLUG}:v1`;
const NOW = "2026-07-21T12:00:00.000Z";
const decoder = new TextDecoder();
const baseProject = JSON.parse(
  await readFile(
    new URL(`../public/examples/${SLUG}/project.json`, import.meta.url),
    "utf8",
  ),
);

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function cloneBase() {
  return structuredClone(baseProject);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function exampleFetch(calls: FetchCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ init, url });
    if (url === `/examples/${SLUG}/project.json`) return jsonResponse(cloneBase());
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

test("example documents revalidate so deployed schema updates reach existing visitors", async () => {
  const calls: FetchCall[] = [];
  await new HostedEditorClient({
    fetch: exampleFetch(calls),
    storage: null,
  }).loadProject({ origin: "example", slug: SLUG });

  assert.equal(calls[0]?.init?.cache, "no-cache");
});

test("anonymous edits survive reload and Reset restores the immutable example", async () => {
  const storage = new MemoryStorage();
  const firstClient = new HostedEditorClient({
    fetch: exampleFetch(),
    now: () => NOW,
    storage,
  });
  const base = await firstClient.loadProject({ origin: "example", slug: SLUG });

  const refingered = await firstClient.refingerProject({
    expectedRevision: base.revision,
    mode: "easiest",
    projectId: base.id,
    sourceVersionId: base.active_version_id,
  });
  const switched = await firstClient.applyVersionAction({
    action: { type: "activate", versionId: base.active_version_id },
    expectedRevision: refingered.revision,
    projectId: refingered.id,
  });
  assert.equal(switched.active_version_id, base.active_version_id);
  assert.equal(switched.versions.length, base.versions.length + 1);
  assert.equal(JSON.parse(storage.getItem(DRAFT_KEY)!).revision, switched.revision);

  const reloaded = await new HostedEditorClient({
    fetch: exampleFetch(),
    storage,
  }).loadProject({ origin: "example", slug: SLUG });
  assert.equal(reloaded.revision, switched.revision);
  assert.equal(reloaded.versions.length, switched.versions.length);
  assert.equal(reloaded.active_version_id, base.active_version_id);

  const reset = await firstClient.resetExample(SLUG);
  assert.equal(reset.revision, base.revision);
  assert.equal(reset.versions.length, base.versions.length);
  assert.equal(storage.getItem(DRAFT_KEY), null);
});

test("phrase refingering forwards the range and constraints into a mixed version", async () => {
  const storage = new MemoryStorage();
  const client = new HostedEditorClient({
    fetch: exampleFetch(),
    now: () => NOW,
    storage,
  });
  const base = await client.loadProject({ origin: "example", slug: SLUG });
  const source = base.versions.find(
    (version: { id: string }) => version.id === base.active_version_id,
  )!;
  const firstNote = source.tab.notes[0];
  const ticksPerBar =
    source.tab.ticks_per_quarter *
    source.tab.time_signature[0] *
    (4 / source.tab.time_signature[1]);
  const barOffset = source.tab.bar_offset_ticks ?? 0;
  const selectedBarStart = Math.max(
    0,
    Math.floor((firstNote.score_tick - barOffset) / ticksPerBar) * ticksPerBar +
      barOffset,
  );
  const selectedBarEnd = selectedBarStart + ticksPerBar;

  const edited = await client.refingerProject({
    constraints: {
      allowedStrings: source.tab.tuning.map((_: number, index: number) => index + 1),
      maxFret: source.tab.fret_count,
      minFret: 0,
    },
    expectedRevision: base.revision,
    mode: "easiest",
    name: "Opening bar · Easiest",
    projectId: base.id,
    range: {
      startScoreTick: firstNote.score_tick,
      endScoreTick: firstNote.score_tick + 1,
    },
    sourceVersionId: source.id,
  });

  const phraseVersion = edited.versions.find(
    (version) => version.id === edited.active_version_id,
  )!;
  assert.equal(phraseVersion.fingering_mode, "mixed");
  assert.equal(phraseVersion.name, "Opening bar · Easiest");
  assert.equal(edited.versions.length, base.versions.length + 1);
  assert.deepEqual(
    base.versions.find((version) => version.id === source.id),
    source,
    "the source version remains immutable",
  );
  for (const [index, note] of phraseVersion.tab.notes.entries()) {
    if (note.score_tick < selectedBarStart || note.score_tick >= selectedBarEnd) {
      assert.deepEqual(note, source.tab.notes[index]);
    }
  }
  assert.equal(JSON.parse(storage.getItem(DRAFT_KEY)!).active_version_id, phraseVersion.id);
});

test("replace-beat-map persists timing on the target hosted version only", async () => {
  const storage = new MemoryStorage();
  const client = new HostedEditorClient({
    fetch: exampleFetch(),
    now: () => NOW,
    storage,
  });
  const base = await client.loadProject({ origin: "example", slug: SLUG });
  const twoVersions = await client.refingerProject({
    expectedRevision: base.revision,
    mode: "balanced",
    projectId: base.id,
    sourceVersionId: base.active_version_id,
  });
  const target = twoVersions.versions.find(
    (version) => version.id === twoVersions.active_version_id,
  )!;
  const untouched = twoVersions.versions.find((version) => version.id !== target.id)!;

  const edited = await client.applyVersionAction({
    action: {
      type: "replace-beat-map",
      versionId: target.id,
      beatMap: {
        bar_offset_ticks: 240,
        sync_anchors: target.tab.sync_anchors.map((anchor) => ({ ...anchor })),
        tempo_bpm: target.tab.tempo_bpm,
        time_signature: [...target.tab.time_signature],
      },
    },
    expectedRevision: twoVersions.revision,
    projectId: twoVersions.id,
  });

  const updatedTarget = edited.versions.find((version) => version.id === target.id)!;
  assert.equal(updatedTarget.tab.bar_offset_ticks, 240);
  assert.equal(updatedTarget.updated_at, NOW);
  assert.deepEqual(
    edited.versions.find((version) => version.id === untouched.id),
    untouched,
  );
  const savedDraft = JSON.parse(storage.getItem(DRAFT_KEY)!);
  assert.equal(
    savedDraft.versions.find((version: { id: string }) => version.id === target.id).tab
      .bar_offset_ticks,
    240,
  );
});

test("legacy anonymous drafts inherit deterministic example chords", async () => {
  const storage = new MemoryStorage();
  const legacyDraft = cloneBase();
  legacyDraft.revision += 1;
  legacyDraft.versions[0].tab.notes[0].reviewed = true;
  for (const version of legacyDraft.versions) delete version.tab.chords;
  storage.setItem(DRAFT_KEY, JSON.stringify(legacyDraft));

  const restored = await new HostedEditorClient({
    fetch: exampleFetch(),
    storage,
  }).loadProject({ origin: "example", slug: SLUG });

  assert.equal(restored.revision, legacyDraft.revision);
  assert.equal(restored.versions[0].tab.notes[0].reviewed, true);
  assert.deepEqual(
    restored.versions.map((version) => version.tab.chords.events.length),
    baseProject.versions.map((version: { tab: { chords: { events: unknown[] } } }) =>
      version.tab.chords.events.length
    ),
  );
  assert.ok(restored.versions.every((version) => version.tab.chords.engine !== "manual"));
});

test("hosted exports produce parseable JSON, MusicXML, MIDI, and ASCII", async () => {
  const client = new HostedEditorClient({ fetch: exampleFetch(), storage: null });
  const project = await client.loadProject({ origin: "example", slug: SLUG });

  const json = await client.exportProject({ format: "json", project });
  const envelope = JSON.parse(decoder.decode(json.bytes));
  assert.equal(envelope.format, "solotrace-project");
  assert.equal(envelope.project.id, project.id);

  const musicXml = await client.exportProject({ format: "musicxml", project });
  const xml = decoder.decode(musicXml.bytes);
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<score-partwise version="4\.0">/);
  assert.match(xml, /<\/score-partwise>\s*$/);

  const midi = await client.exportProject({ format: "midi", project });
  assert.equal(decoder.decode(midi.bytes.slice(0, 4)), "MThd");
  assert.equal(decoder.decode(midi.bytes.slice(14, 18)), "MTrk");

  const ascii = await client.exportProject({ format: "ascii", project });
  assert.match(decoder.decode(ascii.bytes), /Northbound Lights/);
  for (const artifact of [json, musicXml, midi, ascii]) {
    assert.ok(artifact.filename.length > 4);
    assert.ok(artifact.bytes.length > 20);
  }
});

test("Save a copy posts edited state and normalizes the private record", async () => {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ init, url });
    if (url === `/examples/${SLUG}/project.json`) return jsonResponse(cloneBase());
    if (url === "/api/saved-projects" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return jsonResponse({
        project: {
          createdAt: NOW,
          document: body.document,
          exampleSlug: body.exampleSlug,
          id: "saved-copy-1",
          revision: 1,
          title: body.title,
          updatedAt: NOW,
        },
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const client = new HostedEditorClient({ fetch: fetcher, now: () => NOW });
  const example = await client.loadProject({ origin: "example", slug: SLUG });
  const edited = await client.refingerProject({
    expectedRevision: example.revision,
    mode: "position",
    projectId: example.id,
    sourceVersionId: example.active_version_id,
  });
  const saved = await client.saveProject({ asCopy: true, project: edited });

  const post = calls.find((call) => call.url === "/api/saved-projects")!;
  const body = JSON.parse(String(post.init?.body));
  assert.equal(post.init?.method, "POST");
  assert.equal(new Headers(post.init?.headers).get("content-type"), "application/json");
  assert.equal(body.exampleSlug, SLUG);
  assert.equal(body.document.revision, edited.revision);
  assert.equal(body.document.origin, "saved-example");
  assert.equal(saved.id, "saved-copy-1");
  assert.equal(saved.origin, "saved-example");
  assert.equal(saved.example_slug, SLUG);
  assert.equal(saved.revision, 1);
});

test("an unauthenticated Save a copy leaves the anonymous draft recoverable", async () => {
  const storage = new MemoryStorage();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url === `/examples/${SLUG}/project.json`) return jsonResponse(cloneBase());
    if (url === "/api/saved-projects" && init?.method === "POST") {
      return jsonResponse(
        { code: "authentication_required", error: "Sign in with ChatGPT" },
        401,
      );
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const firstClient = new HostedEditorClient({ fetch: fetcher, storage });
  const base = await firstClient.loadProject({ origin: "example", slug: SLUG });
  const edited = await firstClient.refingerProject({
    expectedRevision: base.revision,
    mode: "easiest",
    projectId: base.id,
    sourceVersionId: base.active_version_id,
  });

  await assert.rejects(
    firstClient.saveProject({ asCopy: true, project: edited }),
    (error) =>
      error instanceof EditorClientHttpError &&
      error.status === 401 &&
      error.code === "authentication_required",
  );
  const recovered = await new HostedEditorClient({
    fetch: exampleFetch(),
    storage,
  }).loadProject({ origin: "example", slug: SLUG });
  assert.equal(recovered.revision, edited.revision);
  assert.equal(recovered.active_version_id, edited.active_version_id);
});

test("local and server revision conflicts expose the current revision", async () => {
  const localClient = new HostedEditorClient({ fetch: exampleFetch(), storage: null });
  const example = await localClient.loadProject({ origin: "example", slug: SLUG });
  await assert.rejects(
    localClient.applyVersionAction({
      action: { type: "activate", versionId: example.active_version_id },
      expectedRevision: example.revision + 1,
      projectId: example.id,
    }),
    (error) =>
      error instanceof EditorClientHttpError &&
      error.status === 409 &&
      error.code === "revision_conflict" &&
      error.currentRevision === example.revision,
  );

  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ init, url });
    if (url === "/api/saved-projects/private-1" && !init?.method) {
      return jsonResponse({
        project: {
          createdAt: NOW,
          document: { ...cloneBase(), origin: "saved-example" },
          exampleSlug: SLUG,
          id: "private-1",
          revision: 4,
          title: "Private take",
          updatedAt: NOW,
        },
      });
    }
    if (url === "/api/saved-projects/private-1" && init?.method === "PATCH") {
      return jsonResponse(
        {
          code: "revision_conflict",
          currentRevision: 7,
          error: "This copy changed in another session",
        },
        409,
      );
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const savedClient = new HostedEditorClient({ fetch: fetcher });
  const saved = await savedClient.loadProject({ origin: "saved-example", id: "private-1" });
  await assert.rejects(
    savedClient.saveProject({
      expectedRevision: saved.revision,
      project: { ...saved, title: "Changed title" },
    }),
    (error) =>
      error instanceof EditorClientHttpError &&
      error.status === 409 &&
      error.code === "revision_conflict" &&
      error.currentRevision === 7,
  );
  const patch = calls.find((call) => call.init?.method === "PATCH")!;
  assert.equal(JSON.parse(String(patch.init?.body)).expectedRevision, 4);
});

test("blocked browser storage degrades to in-memory editing", async () => {
  const blockedStorage = {
    getItem(): never {
      throw new DOMException("Blocked", "SecurityError");
    },
    removeItem(): never {
      throw new DOMException("Blocked", "SecurityError");
    },
    setItem(): never {
      throw new DOMException("Blocked", "SecurityError");
    },
  };
  const client = new HostedEditorClient({
    fetch: exampleFetch(),
    storage: blockedStorage,
  });
  const base = await client.loadProject({ origin: "example", slug: SLUG });
  const edited = await client.refingerProject({
    expectedRevision: base.revision,
    mode: "easiest",
    projectId: base.id,
    sourceVersionId: base.active_version_id,
  });
  assert.equal(edited.revision, base.revision + 1);
  const reset = await client.resetExample(SLUG);
  assert.equal(reset.revision, base.revision);
});
