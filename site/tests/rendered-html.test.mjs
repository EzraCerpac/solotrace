import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function builtJavaScript() {
  const server = await readFile(
    new URL("../dist/server/index.js", import.meta.url),
    "utf8",
  );
  const clientDirectory = new URL("../dist/client/assets/", import.meta.url);
  const clientFiles = (await readdir(clientDirectory)).filter((name) => name.endsWith(".js"));
  const client = await Promise.all(
    clientFiles.map((name) => readFile(new URL(name, clientDirectory), "utf8")),
  );
  return [server, ...client].join("\n");
}

test("bundles the public example gallery", async () => {
  const source = await builtJavaScript();
  assert.match(source, /SoloTrace/);
  assert.match(source, /Hear the phrase\. Trace the fingering\./);
  assert.match(source, /Northbound Lights/);
  assert.match(source, /Switchback Run/);
  assert.match(source, /Low Orbit/);
  assert.match(source, /no key required/i);
  assert.match(source, /CC0/);
  assert.doesNotMatch(source, /Your site is taking shape|codex-preview/);
});

test("bundles a lazy, anonymous example session", async () => {
  const source = await builtJavaScript();
  assert.match(source, /Low Orbit/);
  assert.match(source, /Setting up a local working copy/);
  assert.match(source, /No account, key, upload, or processing job is needed/);
});

test("ships the required Sites and social-preview artifacts", async () => {
  const hosting = JSON.parse(
    await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  );
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/examples/catalog.json", import.meta.url));
});
