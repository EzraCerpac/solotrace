import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the built Worker locally with its generated configuration and asset binding.
process.env.WRANGLER_SEND_METRICS = "false";
process.env.WRANGLER_WRITE_LOGS = "false";
let worker;

before(async () => {
  const { unstable_dev } = await import("wrangler");
  worker = await unstable_dev(fileURLToPath(new URL("../dist/server/index.js", import.meta.url)), {
    config: fileURLToPath(new URL("../dist/server/wrangler.json", import.meta.url)),
    local: true,
    ip: "127.0.0.1",
    port: 0,
    inspectorPort: 0,
    persist: false,
    logLevel: "none",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, watch: false, testMode: true },
  });
});

after(async () => { await worker?.stop(); });

test("the built Worker renders the gallery and example navigation routes", async () => {
  const response = await worker.fetch("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const gallery = await response.text();
  for (const [slug, title] of [["northbound-lights", "Northbound Lights"], ["switchback-run", "Switchback Run"], ["low-orbit", "Low Orbit"]]) {
    assert.ok(gallery.includes(title));
    assert.ok(gallery.includes(`href="/try/${slug}"`));
    const session = await worker.fetch(`/try/${slug}`);
    assert.equal(session.status, 200);
    assert.ok((await session.text()).includes(title));
    const navigation = await worker.fetch(`/try/${slug}.rsc`, { headers: { RSC: "1", Accept: "text/x-component" } });
    assert.equal(navigation.status, 200);
    assert.match(navigation.headers.get("content-type"), /text\/x-component/);
    assert.ok((await navigation.text()).includes(slug));
  }
  assert.equal((await worker.fetch("/try/unknown-example")).status, 404);
});

test("the built Worker serves its PNG preview and rejects invalid optimizer requests", async () => {
  const image = await worker.fetch("/og.png");
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /image\/png/);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await worker.fetch("/_vinext/image")).status, 400);
  assert.equal((await worker.fetch("/_vinext/image?url=https%3A%2F%2Funtrusted.invalid%2Fpreview.png&w=640&q=75")).status, 400);
  assert.equal((await worker.fetch("/_vinext/image?url=%2Fog.png&w=999999&q=75")).status, 400);
});
