import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const fromNext = createRequire(import.meta.resolve("next"));
const fromWrangler = createRequire(import.meta.resolve("wrangler"));
const fromMiniflare = createRequire(fromWrangler.resolve("miniflare"));
const fromWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const fromJsdom = createRequire(fromWeb.resolve("jsdom"));
const fromTailwind = createRequire(import.meta.resolve("@tailwindcss/postcss"));
const fromTailwindNode = createRequire(fromTailwind.resolve("@tailwindcss/node"));
const fromPostcss = createRequire(fromTailwind.resolve("postcss"));
const fromCssTree = createRequire(fromJsdom.resolve("css-tree"));
const fromEslint = createRequire(import.meta.resolve("eslint"));

test("Next and Miniflare can resize and encode images with the patched sharp", async () => {
  for (const consumer of [fromNext, fromMiniflare]) {
    const sharp = consumer("sharp");
    const input = await sharp({
      create: { width: 8, height: 6, channels: 4, background: "#ff0000" },
    }).png().toBuffer();
    for (const format of ["png", "webp", "avif"]) {
      const output = await sharp(input).resize(4, 3).toFormat(format).toBuffer();
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 4);
      assert.equal(metadata.height, 3);
      assert.equal(metadata.format, format === "avif" ? "heif" : format);
    }
  }
});

test("ESLint's minimatch retains brace glob and numeric range matching", () => {
  const { minimatch, braceExpand } = fromEslint("minimatch");
  assert.deepEqual(braceExpand("track-{01..03}.{wav,mp3}"), [
    "track-01.wav", "track-01.mp3", "track-02.wav", "track-02.mp3",
    "track-03.wav", "track-03.mp3",
  ]);
  assert.equal(minimatch("track-02.wav", "track-{01..03}.{wav,mp3}"), true);
  assert.equal(minimatch("track-04.wav", "track-{01..03}.{wav,mp3}"), false);
});

test("jsdom and Miniflare's undici support fetch request and response bodies", async () => {
  for (const consumer of [fromJsdom, fromMiniflare]) {
    const { MockAgent, fetch } = consumer("undici");
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    dispatcher.get("https://studio.example").intercept({
      path: "/save", method: "POST", body: "project=demo",
    }).reply(201, '{"saved":true}', { headers: { "content-type": "application/json" } });
    try {
      const response = await fetch("https://studio.example/save", {
        method: "POST", body: "project=demo", dispatcher,
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { saved: true });
      dispatcher.assertNoPendingInterceptors();
    } finally {
      await dispatcher.close();
    }
  }
});

test("Miniflare still dispatches Worker requests with the patched dependencies", async () => {
  const { Miniflare } = fromWrangler("miniflare");
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch(request) { return Response.json({ path: new URL(request.url).pathname }); } };',
  });
  try {
    const response = await worker.dispatchFetch("https://studio.example/health");
    assert.deepEqual(await response.json(), { path: "/health" });
  } finally {
    await worker.dispose();
  }
});

for (const [name, consumer] of [
  ["Tailwind", fromTailwindNode], ["PostCSS", fromPostcss], ["css-tree", fromCssTree],
] as const) {
  test(`${name}'s source-map-js preserves source mappings`, () => {
    const { SourceMapGenerator, SourceMapConsumer, SourceNode } = consumer("source-map-js");
    const map = new SourceMapGenerator({ file: "built.css" });
    map.addMapping({
      generated: { line: 1, column: 0 }, original: { line: 2, column: 0 }, source: "input.css",
    });
    const reader = new SourceMapConsumer(map.toJSON());
    assert.deepEqual(reader.originalPositionFor({ line: 1, column: 0 }), {
      source: "input.css", line: 2, column: 0, name: null,
    });
    assert.equal(SourceNode.fromStringWithSourceMap("a { color: red; }", reader).toString(), "a { color: red; }");
  });

  test(`${name}'s source-map-js handles indexed offsets beyond the generated code without hanging`, () => {
    const result = spawnSync(process.execPath, [
      "-e",
      `const assert = require("node:assert/strict");
const { SourceMapConsumer, SourceNode } = require(process.argv[1]);
const indexed = (line) => ({ version: 3, sections: [{
  offset: { line, column: 0 },
  map: { version: 3, sources: ["input.css"], sourcesContent: ["a {}"], names: [], mappings: "AAAA" }
}] });
assert.throws(() => SourceNode.fromStringWithSourceMap("a {}",
  new SourceMapConsumer(indexed(1000000000000))), /Section offset line/);
assert.equal(SourceNode.fromStringWithSourceMap("a {}",
  new SourceMapConsumer(indexed(1000000))).toString(), "a {}");
console.log("bounded-offset");`,
      consumer.resolve("source-map-js"),
    ], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^bounded-offset\n$/);
  });
}
