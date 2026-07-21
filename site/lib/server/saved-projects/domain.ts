export const MAX_SAVED_PROJECTS_PER_OWNER = 3;
export const MAX_SAVED_PROJECT_BYTES = 256 * 1024;
export const MAX_PROJECT_TITLE_LENGTH = 120;
export const MAX_EXAMPLE_SLUG_LENGTH = 80;

const EXAMPLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXAMPLE_SLUGS = new Set([
  "northbound-lights",
  "switchback-run",
  "low-orbit",
]);

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export type SavedProjectSummary = {
  id: string;
  exampleSlug: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedProject = SavedProjectSummary & {
  document: JsonObject;
};

export type CreateSavedProjectInput = {
  exampleSlug: string;
  title: string;
  document: JsonObject;
  documentJson: string;
};

export type PatchSavedProjectInput = {
  expectedRevision: number;
  title?: string;
  document?: JsonObject;
  documentJson?: string;
};

export class SavedProjectInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SavedProjectInputError";
    this.code = code;
  }
}

export function normalizeOwnerEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function deriveOwnerId(
  email: string,
  secret: string,
): Promise<string> {
  const normalizedEmail = normalizeOwnerEmail(email);
  if (!normalizedEmail) {
    throw new Error("Authenticated user email is empty");
  }
  if (!secret) {
    throw new Error("SOLOTRACE_OWNER_ID_SECRET is not configured");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(normalizedEmail),
  );

  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function parseCreateSavedProjectInput(
  value: unknown,
): CreateSavedProjectInput {
  const record = requireRecord(value, "request body");
  const exampleSlug = requireExampleSlug(record.exampleSlug);
  const title = requireTitle(record.title);
  const { document, documentJson } = requireProjectDocument(record.document);

  return { document, documentJson, exampleSlug, title };
}

export function parsePatchSavedProjectInput(
  value: unknown,
): PatchSavedProjectInput {
  const record = requireRecord(value, "request body");
  const expectedRevision = record.expectedRevision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new SavedProjectInputError(
      "invalid_expected_revision",
      "expectedRevision must be a positive integer",
    );
  }

  const hasTitle = Object.hasOwn(record, "title");
  const hasDocument = Object.hasOwn(record, "document");
  if (!hasTitle && !hasDocument) {
    throw new SavedProjectInputError(
      "empty_patch",
      "Provide title or document to update",
    );
  }

  const result: PatchSavedProjectInput = { expectedRevision };
  if (hasTitle) result.title = requireTitle(record.title);
  if (hasDocument) {
    const { document, documentJson } = requireProjectDocument(record.document);
    result.document = document;
    result.documentJson = documentJson;
  }
  return result;
}

export function parseStoredDocument(documentJson: string): JsonObject {
  const document: unknown = JSON.parse(documentJson);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("Stored saved-project document is not a JSON object");
  }
  return document as JsonObject;
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SavedProjectInputError(
      "invalid_document",
      `${label} must be a JSON object`,
    );
  }
  return value as JsonObject;
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new SavedProjectInputError("invalid_title", "title is required");
  }
  const title = value.trim();
  if (!title) {
    throw new SavedProjectInputError("invalid_title", "title is required");
  }
  if (title.length > MAX_PROJECT_TITLE_LENGTH) {
    throw new SavedProjectInputError(
      "invalid_title",
      `title must be at most ${MAX_PROJECT_TITLE_LENGTH} characters`,
    );
  }
  return title;
}

function requireExampleSlug(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_EXAMPLE_SLUG_LENGTH ||
    !EXAMPLE_SLUG_PATTERN.test(value) ||
    !EXAMPLE_SLUGS.has(value)
  ) {
    throw new SavedProjectInputError(
      "invalid_example_slug",
      "exampleSlug must identify a published SoloTrace example",
    );
  }
  return value;
}

function requireProjectDocument(value: unknown): {
  document: JsonObject;
  documentJson: string;
} {
  const document = requireRecord(value, "document");
  const documentJson = JSON.stringify(document);
  const size = new TextEncoder().encode(documentJson).byteLength;
  if (size > MAX_SAVED_PROJECT_BYTES) {
    throw new SavedProjectInputError(
      "document_too_large",
      `document must be at most ${MAX_SAVED_PROJECT_BYTES} bytes`,
    );
  }
  return { document, documentJson };
}
