import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const fromHooks = createRequire(createRequire(import.meta.resolve("eslint-config-next")).resolve("eslint-plugin-react-hooks"));
const fromBabel = createRequire(fromHooks.resolve("@babel/core"));
const fromTargets = createRequire(fromBabel.resolve("@babel/helper-compilation-targets"));
const browserslist = fromTargets("browserslist");
const fromWebpack = createRequire(createRequire(import.meta.resolve("react-server-dom-webpack")).resolve("webpack"));
const fromAjv = createRequire(createRequire(fromWebpack.resolve("schema-utils")).resolve("ajv"));
const uri = fromAjv("fast-uri");
const fromOg = createRequire(createRequire(import.meta.resolve("vinext")).resolve("@vercel/og"));
const fromFont = createRequire(createRequire(fromOg.resolve("satori")).resolve("@shuding/opentype.js"));
const fromVitest = createRequire(import.meta.resolve("vitest"));

test("Babel's Browserslist accepts custom stats containing prototype member names", () => {
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
    const stats = JSON.parse(`{"${key}":{"onekey":5},"chrome":{"100":50}}`);
    assert.ok(browserslist("defaults", { stats }).length > 0);
  }
  assert.deepEqual(browserslist("> 1% in my stats", { stats: { chrome: { "100": 50 } } }), ["chrome 100"]);
});

test("Browserslist evicts old query results and parsed queries", () => {
  const firstQuery = "since 1900-01-01";
  const result = browserslist(firstQuery);
  const parsed = browserslist.parse(firstQuery);
  assert.equal(browserslist(firstQuery), result);
  for (let day = 2; day <= 602; day++) browserslist(`since 1900-01-${day}`);
  assert.notEqual(browserslist(firstQuery), result);
  assert.notEqual(browserslist.parse(firstQuery), parsed);
  assert.deepEqual(browserslist(firstQuery), result);
});

test("Ajv's URI resolver preserves references and rejects host and authority confusion", () => {
  assert.equal(uri.parse("//%41.com").host, "a.com");
  assert.equal(uri.equal("//%41.com", "//a.com"), true);
  assert.equal(uri.resolve("https://studio.example/", "//éxample.com/"), "https://xn--xample-9ua.com/");
  assert.match(uri.parse("http://[::not-valid]/private").error, /host.*malformed/i);
  assert.match(uri.parse("%2f%2fevil.example:/pwn").error, /scheme.*malformed/i);
  const nestedHost = "http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/";
  assert.notEqual(uri.normalize(nestedHost), "http://localhost/");
  assert.throws(() => uri.serialize({ scheme: "http", host: "trusted.example", port: "@127.0.0.1:8124", path: "/app" }), /port.*malformed/i);
  const Ajv = createRequire(fromWebpack.resolve("schema-utils"))("ajv");
  const ajv = new Ajv();
  ajv.addSchema({ $id: "https://studio.example/schemas/project", type: "object", required: ["name"], properties: { name: { type: "string" } } });
  const validate = ajv.compile({ $ref: "https://studio.example/schemas/project" });
  assert.equal(validate({ name: "demo" }), true);
  assert.equal(validate({ name: 3 }), false);
});

test("the OpenType font parser's ZIP library round trips and rejects malformed ZIP64 promptly", () => {
  const { zipSync, unzipSync, strToU8, strFromU8 } = fromFont("fflate");
  const zipped = zipSync({ "score.txt": strToU8("demo score") });
  assert.equal(strFromU8(unzipSync(zipped)["score.txt"]), "demo score");
  const result = spawnSync(process.execPath, ["-e", `
const assert = require("node:assert/strict");
const { zipSync, unzipSync, strToU8 } = require(process.argv[1]);
const zip = zipSync({ "score.txt": strToU8("demo score") });
const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
let offset = 0;
while (offset < zip.length - 4 && view.getUint32(offset, true) !== 0x02014b50) offset++;
assert.ok(offset < zip.length - 4);
assert.equal(view.getUint16(offset + 30, true), 0);
view.setUint32(offset + 20, 0xffffffff, true);
// Mark the archive as ZIP64 while deliberately omitting the entry's ZIP64 extra field.
const endOffset = zip.length - 22;
const zip64 = new Uint8Array(76);
const zip64View = new DataView(zip64.buffer);
zip64View.setUint32(0, 0x06064b50, true);
zip64View.setUint32(4, 44, true);
zip64View.setUint32(32, 1, true);
zip64View.setUint32(48, offset, true);
zip64View.setUint32(56, 0x07064b50, true);
zip64View.setUint32(64, endOffset, true);
const end = zip.slice(endOffset);
const endView = new DataView(end.buffer);
endView.setUint16(8, 0xffff, true);
endView.setUint32(16, 0xffffffff, true);
const malformed = new Uint8Array(endOffset + zip64.length + end.length);
malformed.set(zip.subarray(0, endOffset));
malformed.set(zip64, endOffset);
malformed.set(end, endOffset + zip64.length);
assert.throws(() => unzipSync(malformed), /invalid zip data/i);
console.log("zip64-rejected");`, fromFont.resolve("fflate")], { encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "zip64-rejected\n");
});

test("Vitest's redirect mock respects Vite's file allowlist and deny rules", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "solotrace-mock-"));
  const root = join(fixture, "root");
  await mkdir(root);
  await writeFile(join(root, "allowed.js"), "export const value = 42;");
  await writeFile(join(root, "private.txt"), "private fixture");
  await writeFile(join(fixture, "outside.txt"), "outside fixture");
  const server = await createServer({ configFile: false, root, logLevel: "silent", server: { middlewareMode: true, fs: { strict: true, allow: [root], deny: ["**/private.txt"] } } });
  try {
    const { interceptorPlugin } = await import(fromVitest.resolve("@vitest/mocker/node"));
    const plugin = interceptorPlugin();
    const events = new EventEmitter();
    // Dispatch the plugin's WebSocket registration boundary; use Vite's real config and file guard.
    plugin.configureServer({ ...server, ws: { on: events.on.bind(events), send() {} } });
    for (const [id, redirect, expected] of [
      ["/allowed", "http://localhost/allowed.js", "export const value = 42;"],
      ["/denied", "http://localhost/private.txt", undefined],
      ["/outside", "opaque:../outside.txt", undefined],
    ]) {
      events.emit("vitest:interceptor:register", { type: "redirect", raw: id, id, url: id, redirect });
      assert.equal(await plugin.load.handler(id), expected);
    }
  } finally {
    await server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
