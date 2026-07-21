import {
  MAX_SAVED_PROJECT_BYTES,
  SavedProjectInputError,
} from "./domain.ts";

// Leave room for the title, example slug, revision, and JSON envelope while
// keeping request buffering close to the 256 KiB document limit.
export const MAX_SAVED_PROJECT_REQUEST_BYTES =
  MAX_SAVED_PROJECT_BYTES + 16 * 1024;

type SavedProjectRequestErrorStatus = 400 | 403 | 413 | 415;

export class SavedProjectRequestError extends Error {
  readonly code: string;
  readonly status: SavedProjectRequestErrorStatus;

  constructor(
    status: SavedProjectRequestErrorStatus,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "SavedProjectRequestError";
    this.code = code;
    this.status = status;
  }
}

export type SavedProjectClientError = {
  status: number;
  code: string;
  message: string;
};

export function savedProjectClientError(
  error: unknown,
): SavedProjectClientError | null {
  if (error instanceof SavedProjectRequestError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof SavedProjectInputError) {
    return { code: error.code, message: error.message, status: 400 };
  }
  return null;
}

/**
 * Require browser mutation requests to prove that they came from this origin.
 * A matching Origin is preferred; Sec-Fetch-Site is a safe fallback for user
 * agents that omit Origin. Missing provenance is rejected, not guessed.
 */
export function assertSafeMutationRequest(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  const origin = request.headers.get("origin")?.trim();

  if (fetchSite && fetchSite !== "same-origin") {
    throw forbiddenMutation();
  }

  if (origin) {
    if (serializedOrigin(origin) !== new URL(request.url).origin) {
      throw forbiddenMutation();
    }
    return;
  }

  if (fetchSite === "same-origin") return;
  throw forbiddenMutation();
}

export async function readJsonBody(request: Request): Promise<unknown> {
  requireJsonContentType(request.headers.get("content-type"));
  rejectOversizedContentLength(request.headers.get("content-length"));

  const bytes = await readBoundedBody(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidJson();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidJson();
  }
}

function requireJsonContentType(contentType: string | null): void {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new SavedProjectRequestError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
}

function rejectOversizedContentLength(contentLength: string | null): void {
  if (contentLength === null) return;
  const length = Number(contentLength);
  if (Number.isFinite(length) && length > MAX_SAVED_PROJECT_REQUEST_BYTES) {
    throw requestTooLarge();
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SAVED_PROJECT_REQUEST_BYTES) {
        await reader.cancel();
        throw requestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function serializedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

function forbiddenMutation(): SavedProjectRequestError {
  return new SavedProjectRequestError(
    403,
    "cross_site_request",
    "Saved-project changes must come from this site",
  );
}

function requestTooLarge(): SavedProjectRequestError {
  return new SavedProjectRequestError(
    413,
    "request_too_large",
    `Request body must be at most ${MAX_SAVED_PROJECT_REQUEST_BYTES} bytes`,
  );
}

function invalidJson(): SavedProjectRequestError {
  return new SavedProjectRequestError(
    400,
    "invalid_json",
    "Request body must be valid JSON",
  );
}
