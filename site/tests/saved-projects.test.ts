import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  MAX_SAVED_PROJECT_BYTES,
  SavedProjectInputError,
  deriveOwnerId,
  normalizeOwnerEmail,
  parseCreateSavedProjectInput,
  parsePatchSavedProjectInput,
} from "../lib/server/saved-projects/domain.ts";

test("owner ids use an HMAC of the normalized email", async () => {
  const email = "  Musician@Example.COM ";
  const secret = "unit-test-secret";
  const expected = createHmac("sha256", secret)
    .update("musician@example.com")
    .digest("hex");

  assert.equal(normalizeOwnerEmail(email), "musician@example.com");
  assert.equal(await deriveOwnerId(email, secret), expected);
  assert.equal((await deriveOwnerId(email, secret)).length, 64);
});

test("create input trims metadata and preserves an editor document", () => {
  const parsed = parseCreateSavedProjectInput({
    exampleSlug: "northbound-lights",
    title: "  My take  ",
    document: { origin: "saved-example", notes: [{ pitch: 64 }] },
  });

  assert.equal(parsed.exampleSlug, "northbound-lights");
  assert.equal(parsed.title, "My take");
  assert.deepEqual(parsed.document, {
    origin: "saved-example",
    notes: [{ pitch: 64 }],
  });
  assert.equal(JSON.parse(parsed.documentJson).origin, "saved-example");
});

test("documents above 256 KiB are rejected by UTF-8 byte size", () => {
  const oversizedDocument = { value: "é".repeat(MAX_SAVED_PROJECT_BYTES) };
  assert.throws(
    () =>
      parseCreateSavedProjectInput({
        exampleSlug: "low-orbit",
        title: "Too large",
        document: oversizedDocument,
      }),
    (error) =>
      error instanceof SavedProjectInputError &&
      error.code === "document_too_large",
  );
});

test("patches require an expected revision and at least one change", () => {
  assert.throws(
    () => parsePatchSavedProjectInput({ title: "No revision" }),
    (error) =>
      error instanceof SavedProjectInputError &&
      error.code === "invalid_expected_revision",
  );
  assert.throws(
    () => parsePatchSavedProjectInput({ expectedRevision: 2 }),
    (error) =>
      error instanceof SavedProjectInputError && error.code === "empty_patch",
  );

  assert.deepEqual(
    parsePatchSavedProjectInput({ expectedRevision: 2, title: "  Revision 3 " }),
    { expectedRevision: 2, title: "Revision 3" },
  );
});

test("saved copies must come from the immutable example catalog", () => {
  assert.throws(
    () =>
      parseCreateSavedProjectInput({
        exampleSlug: "invented-session",
        title: "Not in the catalog",
        document: {},
      }),
    (error) =>
      error instanceof SavedProjectInputError &&
      error.code === "invalid_example_slug",
  );
});
