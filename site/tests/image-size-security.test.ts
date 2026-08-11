import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const requireFromVinext = createRequire(import.meta.resolve("vinext"));
const imageSizeEntry = requireFromVinext.resolve("image-size");

const malformedImages = {
  heif:
    "0000000c6674797061766966000000386d657461000000000000002c69707270000000246970636f00000000697370650000000000000000000000010000000100000000",
  icns: "69636e730000001049434f4e00000000",
  jxl: "0000000c4a584c20000000000000000c667479706a786c20000000006a786c70",
};

for (const [format, payload] of Object.entries(malformedImages)) {
  test(`image-size rejects malformed ${format} box lengths without hanging`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const { imageSize } = require(process.argv[1]);
try {
  imageSize(Buffer.from(process.argv[2], "hex"));
  console.log("safe-return");
} catch {
  console.log("safe-throw");
}`,
        imageSizeEntry,
        payload,
      ],
      { encoding: "utf8", timeout: 750 },
    );

    assert.notEqual(result.error?.code, "ETIMEDOUT", `${format} parser hung`);
    assert.match(result.stdout, /^safe-(return|throw)\n$/, `${format} parser did not run`);
  });
}
