import assert from "node:assert/strict";
import test from "node:test";
import { SavedProjectInputError } from "../lib/server/saved-projects/domain.ts";
import {
  MAX_SAVED_PROJECT_REQUEST_BYTES,
  SavedProjectRequestError,
  assertSafeMutationRequest,
  readJsonBody,
  savedProjectClientError,
} from "../lib/server/saved-projects/request.ts";

const API_URL = "https://studio.example/api/saved-projects";

test("JSON parsing requires application/json and accepts charset parameters", async () => {
  const request = jsonRequest('{"title":"A take"}', {
    "content-type": "Application/JSON; charset=utf-8",
  });
  assert.deepEqual(await readJsonBody(request), { title: "A take" });

  await assert.rejects(
    readJsonBody(
      new Request(API_URL, {
        body: '{"title":"A take"}',
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
    ),
    requestError(415, "unsupported_media_type"),
  );
});

test("invalid JSON and invalid UTF-8 map to a 400 response", async () => {
  await assert.rejects(
    readJsonBody(jsonRequest("{")),
    requestError(400, "invalid_json"),
  );
  await assert.rejects(
    readJsonBody(
      new Request(API_URL, {
        body: new Uint8Array([0xc3, 0x28]),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ),
    requestError(400, "invalid_json"),
  );
});

test("declared and streamed bodies are both bounded", async () => {
  await assert.rejects(
    readJsonBody(
      jsonRequest("{}", {
        "content-length": String(MAX_SAVED_PROJECT_REQUEST_BYTES + 1),
      }),
    ),
    requestError(413, "request_too_large"),
  );

  await assert.rejects(
    readJsonBody(jsonRequest("x".repeat(MAX_SAVED_PROJECT_REQUEST_BYTES + 1))),
    requestError(413, "request_too_large"),
  );
});

test("mutations accept either a matching Origin or same-origin Fetch Metadata", () => {
  assert.doesNotThrow(() =>
    assertSafeMutationRequest(
      new Request(API_URL, {
        headers: { origin: "https://studio.example" },
        method: "DELETE",
      }),
    ),
  );
  assert.doesNotThrow(() =>
    assertSafeMutationRequest(
      new Request(API_URL, {
        headers: { "sec-fetch-site": "same-origin" },
        method: "DELETE",
      }),
    ),
  );
});

test("mutations reject cross-site, malformed, and unproven provenance", () => {
  const headerCases: HeadersInit[] = [
    new Headers({ origin: "https://attacker.example" }),
    new Headers({
      origin: "https://studio.example",
      "sec-fetch-site": "cross-site",
    }),
    new Headers({ origin: "https://studio.example/path" }),
    new Headers(),
  ];
  for (const headers of headerCases) {
    assert.throws(
      () =>
        assertSafeMutationRequest(
          new Request(API_URL, { headers, method: "DELETE" }),
        ),
      requestError(403, "cross_site_request"),
    );
  }
});

test("request and document validation errors retain distinct HTTP statuses", () => {
  assert.deepEqual(
    savedProjectClientError(
      new SavedProjectRequestError(415, "unsupported_media_type", "JSON only"),
    ),
    { code: "unsupported_media_type", message: "JSON only", status: 415 },
  );
  assert.deepEqual(
    savedProjectClientError(
      new SavedProjectInputError("invalid_title", "title is required"),
    ),
    { code: "invalid_title", message: "title is required", status: 400 },
  );
  assert.equal(savedProjectClientError(new Error("database unavailable")), null);
});

function jsonRequest(
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request(API_URL, {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

function requestError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof SavedProjectRequestError &&
    error.status === status &&
    error.code === code;
}
