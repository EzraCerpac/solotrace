import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const fromEslint = createRequire(import.meta.resolve("eslint"));
const fromEslintrc = createRequire(fromEslint.resolve("@eslint/eslintrc"));
const yaml = fromEslintrc("js-yaml");
const fromTailwind = createRequire(import.meta.resolve("@tailwindcss/postcss"));
const fromPostcss = createRequire(fromTailwind.resolve("postcss"));

test("ESLint's YAML parser preserves anchors, merge keys, and round trips", () => {
  const config = yaml.load("defaults: &defaults {enabled: true}\nproject: {<<: *defaults, name: demo}\n");
  assert.deepEqual(config.project, { enabled: true, name: "demo" });
  assert.deepEqual(yaml.load(yaml.dump(config)), config);
});

test("ESLint's YAML parser charges empty merge sources against its work limit", () => {
  assert.throws(() => yaml.load(
    "defaults: &defaults [{}, {}, {}]\nproject: {<<: *defaults}\n",
    { maxTotalMergeKeys: 2 },
  ), /maxTotalMergeKeys/);
});

test("PostCSS still creates input IDs with the patched Nanoid", () => {
  const postcss = fromTailwind("postcss");
  const root = postcss.parse(".project { color: red; }");
  assert.match(root.source.input.id, /^<input css [\w-]+>$/);
  assert.equal(root.toString(), ".project { color: red; }");
  const { customAlphabet } = fromPostcss("nanoid");
  assert.match(customAlphabet("abc", 12)(), /^[abc]{12}$/);
});

test("Nanoid's native async generator handles zero sizes without looping", () => {
  // Exercise the published native module with a deterministic platform entropy provider.
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--max-old-space-size=128", "-e",
    `const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { SourceTextModule, SyntheticModule } = require("node:vm");
(async () => {
  const root = dirname(process.argv[1]);
  const source = (path) => readFileSync(join(root, path), "utf8");
  const native = new SourceTextModule(source("async/index.native.js"));
  const alphabet = new SourceTextModule(source("url-alphabet/index.js"));
  const entropy = new SyntheticModule(["getRandomBytesAsync"], function () {
    this.setExport("getRandomBytesAsync", async (size) => new Uint8Array(size));
  });
  await native.link((specifier) => {
    if (specifier === "expo-random") return entropy;
    if (specifier === "../url-alphabet/index.js") return alphabet;
    throw new Error("Unexpected dependency: " + specifier);
  });
  await native.evaluate();
  const { customAlphabet } = native.namespace;
  assert.equal(await customAlphabet("abc", 0)(), "");
  const generate = customAlphabet("abc", 12);
  assert.equal(await generate(0), "");
  assert.match(await generate(), /^[abc]{12}$/);
  assert.match(await generate(5), /^[abc]{5}$/);
  console.log("native-zero-size");
})().catch((error) => { console.error(error); process.exit(1); });`,
    fromPostcss.resolve("nanoid/package.json"),
  ], { encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "native-zero-size\n");
});
