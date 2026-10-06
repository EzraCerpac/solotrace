import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const fromNext = createRequire(import.meta.resolve("next"));
const fromEslintConfig = createRequire(import.meta.resolve("eslint-config-next"));
const fromHooks = createRequire(fromEslintConfig.resolve("eslint-plugin-react-hooks"));
const fromBabel = createRequire(fromHooks.resolve("@babel/core"));
const fromTargets = createRequire(fromBabel.resolve("@babel/helper-compilation-targets"));
const fromBrowserslist = createRequire(fromTargets.resolve("browserslist"));

for (const [name, consumer] of [["Next", fromNext], ["Browserslist", fromBrowserslist]] as const) {
  test(`${name}'s Baseline mapping preserves browser version results`, () => {
    const { getCompatibleVersions } = consumer("baseline-browser-mapping");
    const versions = getCompatibleVersions({ targetYear: 2023, suppressWarnings: true });
    assert.ok(versions.length > 0);
    assert.ok(versions.some((version) => version.browser === "chrome"));
    for (const version of versions) {
      assert.equal(typeof version.browser, "string");
      assert.equal(typeof version.version, "string");
    }
  });

  test(`${name}'s Baseline mapping throws on conflicting input without exiting the process`, () => {
    const result = spawnSync(process.execPath, [
      "-e",
      `const assert = require("node:assert/strict");
const { getCompatibleVersions } = require(process.argv[1]);
assert.throws(() => getCompatibleVersions({
  targetYear: 2023, widelyAvailableOnDate: "2024-01-01", suppressWarnings: true,
}), /targetYear.*widelyAvailableOnDate/);
console.log("process-survived");`,
      consumer.resolve("baseline-browser-mapping"),
    ], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "process-survived\n");
  });
}

test("Browserslist and Babel retain Baseline query and compilation target support", () => {
  const browserslist = fromTargets("browserslist");
  const browsers = browserslist("baseline 2023");
  assert.ok(browsers.some((browser) => browser.startsWith("chrome ")));
  const getTargets = fromBabel("@babel/helper-compilation-targets").default;
  const targets = getTargets({ browsers: "baseline 2023" }, { ignoreBrowserslistConfig: true });
  assert.equal(typeof targets.chrome, "string");
  assert.equal(typeof targets.firefox, "string");
});
