import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const requireFromVinext = createRequire(import.meta.resolve("vinext"));
const imageSizeEntry = requireFromVinext.resolve("image-size");
const imageSizeRoot = new URL("../../", pathToFileURL(imageSizeEntry));
const imageSizePackage = JSON.parse(readFileSync(new URL("package.json", imageSizeRoot), "utf8"));
const imageSizeImportEntry = new URL(imageSizePackage.exports["."].import.default, imageSizeRoot).href;

const malformedImages = {
  heif:
    "0000000c6674797061766966000000386d657461000000000000002c69707270000000246970636f00000000697370650000000000000000000000010000000100000000",
  icns: "69636e730000001049434f4e00000000",
  jxl: "0000000c4a584c20000000000000000c667479706a786c20000000006a786c70",
};

for (const [format, payload] of Object.entries(malformedImages)) {
  for (const [mode, entry] of [["require", imageSizeEntry], ["import", imageSizeImportEntry]]) {
    test(`image-size ${mode} rejects malformed ${format} box lengths without hanging`, () => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module", "-e",
          `import assert from "node:assert/strict";
  import { createRequire } from "node:module";
  const { imageSize } = process.argv[3] === "require"
    ? createRequire(import.meta.url)(process.argv[1])
    : await import(process.argv[1]);
  if (process.argv[4] === "icns") {
    assert.throws(() => imageSize(Buffer.from(process.argv[2], "hex")), {
      name: "TypeError", message: "Invalid ICNS entry length",
    });
  }
  try {
    imageSize(Buffer.from(process.argv[2], "hex"));
    console.log("safe-return");
  } catch {
    console.log("safe-throw");
  }`,
          entry,
          payload,
          mode,
          format,
        ],
        { encoding: "utf8", timeout: 2000 },
      );

      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^safe-(return|throw)\n$/, `${format} parser did not run`);
    });
  }
}

test("Vinext's image-size import and require APIs retain valid image dimensions", async () => {
  const fromNext = createRequire(import.meta.resolve("next"));
  const sharp = fromNext("sharp");
  const parsers = [requireFromVinext("image-size"), await import(imageSizeImportEntry)];
  for (const format of ["png", "jpeg", "webp"]) {
    const input = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#ff0000" },
    }).toFormat(format).toBuffer();
    for (const { imageSize } of parsers) {
      const size = imageSize(input);
      assert.equal(size.width, 8);
      assert.equal(size.height, 6);
    }
  }
});
