import {
  HOSTED_EXAMPLE_CAPABILITIES,
  applyVersionAction as applyLocalVersionAction,
  createRefingeredVersion,
  exportProject as createExport,
  isEditorProject,
  type EditorClientAdapter,
  type EditorProject,
  type ExportRequest,
  type FingeringMode,
  type ProjectReference,
  type RefingerProjectRequest,
  type SaveProjectRequest,
  type VersionActionRequest,
} from "@solotrace/editor";

type Fetcher = typeof fetch;
type DraftStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type SavedProjectRecord = {
  id: string;
  exampleSlug: string;
  title: string;
  revision: number;
  document: unknown;
  createdAt: string;
  updatedAt: string;
};

type SavedProjectResponse = {
  project: SavedProjectRecord;
};

type ApiErrorBody = {
  error?: string;
  code?: string;
  currentRevision?: number;
};

export type HostedEditorClientOptions = {
  fetch?: Fetcher;
  now?: () => string;
  storage?: DraftStorage | null;
};

export class EditorClientHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentRevision?: number;

  constructor(message: string, status: number, body?: ApiErrorBody) {
    super(message);
    this.name = "EditorClientHttpError";
    this.status = status;
    this.code = body?.code;
    this.currentRevision = body?.currentRevision;
  }
}

function draftKey(slug: string): string {
  return `solotrace:example-draft:${slug}:v1`;
}

function humanMode(mode: FingeringMode): string {
  if (mode === "position") return "One Position";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function nextVersionId(project: EditorProject, sourceVersionId: string, mode: FingeringMode): string {
  const stem = `${sourceVersionId}-${mode}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  let suffix = 1;
  while (project.versions.some((version) => version.id === `${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function normalizeSavedProject(record: SavedProjectRecord): EditorProject {
  if (!isEditorProject(record.document)) {
    throw new Error("The saved copy contains an invalid editor document");
  }
  return {
    ...record.document,
    id: record.id,
    title: record.title,
    revision: record.revision,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    origin: "saved-example",
    example_slug: record.exampleSlug,
  };
}

function restoreExampleChords(
  draft: EditorProject,
  base: EditorProject,
): EditorProject {
  const baseById = new Map(base.versions.map((version) => [version.id, version]));
  const fallback = baseById.get(base.active_version_id);
  let changed = false;
  const versions = draft.versions.map((version) => {
    const track = version.tab.chords;
    const isLegacyEmptyTrack =
      track.engine === "manual" &&
      track.model_revision === null &&
      track.model_sha256 === null &&
      track.analyzed_start_s === null &&
      track.analyzed_end_s === null &&
      track.events.length === 0;
    const source = baseById.get(version.id) ?? fallback;
    if (!isLegacyEmptyTrack || !source || source.tab.chords.events.length === 0) {
      return version;
    }
    changed = true;
    return {
      ...version,
      tab: {
        ...version.tab,
        chords: structuredClone(source.tab.chords),
      },
    };
  });
  return changed ? { ...draft, versions } : draft;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new EditorClientHttpError(
      body.error ?? `Request failed (${response.status})`,
      response.status,
      body,
    );
  }
  return body;
}

export class HostedEditorClient implements EditorClientAdapter {
  readonly capabilities = HOSTED_EXAMPLE_CAPABILITIES;

  readonly #fetch: Fetcher;
  readonly #now: () => string;
  readonly #storageOverride: DraftStorage | null | undefined;
  readonly #projects = new Map<string, EditorProject>();

  constructor(options: HostedEditorClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#storageOverride = options.storage;
  }

  async loadProject(reference: ProjectReference): Promise<EditorProject> {
    if (reference.origin === "example") return this.#loadExample(reference.slug);
    if (reference.origin === "saved-example") {
      const response = await this.#fetch(
        `/api/saved-projects/${encodeURIComponent(reference.id)}`,
        { cache: "no-store" },
      );
      const { project: record } = await parseResponse<SavedProjectResponse>(response);
      return this.#remember(normalizeSavedProject(record));
    }
    throw new Error("Hosted SoloTrace does not load desktop-local projects");
  }

  async saveProject(request: SaveProjectRequest): Promise<EditorProject> {
    const { project } = request;
    if (project.origin === "local") {
      throw new Error("Hosted SoloTrace cannot save desktop-local projects");
    }

    if (request.asCopy) {
      const exampleSlug = project.example_slug;
      if (!exampleSlug) throw new Error("A saved copy must identify its base example");
      const response = await this.#fetch("/api/saved-projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exampleSlug,
          title: project.title,
          document: { ...project, origin: "saved-example" },
        }),
      });
      const { project: record } = await parseResponse<SavedProjectResponse>(response);
      return this.#remember(normalizeSavedProject(record));
    }

    if (project.origin === "example") {
      this.#writeDraft(project);
      return this.#remember(project);
    }

    const expectedRevision = request.expectedRevision ?? project.revision;
    const response = await this.#fetch(
      `/api/saved-projects/${encodeURIComponent(project.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision,
          title: project.title,
          document: { ...project, origin: "saved-example" },
        }),
      },
    );
    const { project: record } = await parseResponse<SavedProjectResponse>(response);
    return this.#remember(normalizeSavedProject(record));
  }

  async refingerProject(request: RefingerProjectRequest): Promise<EditorProject> {
    const project = this.#loadedProject(request.projectId);
    this.#requireRevision(project, request.expectedRevision);
    const updated = createRefingeredVersion(project, {
      sourceVersionId: request.sourceVersionId,
      mode: request.mode,
      versionId: nextVersionId(project, request.sourceVersionId, request.mode),
      name: request.name?.trim() || humanMode(request.mode),
      createdAt: this.#now(),
      lockPolicy: request.lockPolicy,
      range: request.range,
      constraints: request.constraints,
    });
    return this.#persistMutation(updated, request.expectedRevision);
  }

  async applyVersionAction(request: VersionActionRequest): Promise<EditorProject> {
    const project = this.#loadedProject(request.projectId);
    this.#requireRevision(project, request.expectedRevision);
    const updated = applyLocalVersionAction(project, request.action, this.#now());
    return this.#persistMutation(updated, request.expectedRevision);
  }

  async exportProject(request: ExportRequest) {
    return createExport(request.project, request.format);
  }

  /** Discard an anonymous device draft and reload its immutable CC0 example. */
  async resetExample(slug: string): Promise<EditorProject> {
    this.#removeDraft(slug);
    for (const [id, project] of this.#projects) {
      if (project.origin === "example" && project.example_slug === slug) {
        this.#projects.delete(id);
      }
    }
    return this.#loadExample(slug, true);
  }

  async #loadExample(slug: string, reset = false): Promise<EditorProject> {
    const response = await this.#fetch(
      `/examples/${encodeURIComponent(slug)}/project.json`,
      { cache: "no-cache" },
    );
    const raw: unknown = await parseResponse<unknown>(response);
    if (!isEditorProject(raw)) throw new Error("The example contains an invalid editor document");
    const base: EditorProject = {
      ...raw,
      origin: "example",
      example_slug: slug,
    };
    if (reset) return this.#remember(base);

    const saved = this.#readDraft(slug);
    if (!saved) return this.#remember(base);
    try {
      const draft: unknown = JSON.parse(saved);
      if (
        isEditorProject(draft) &&
        draft.origin === "example" &&
        draft.example_slug === slug
      ) {
        return this.#remember(restoreExampleChords(draft, base));
      }
    } catch {
      // A malformed device draft is disposable; the immutable base stays safe.
    }
    this.#removeDraft(slug);
    return this.#remember(base);
  }

  async #persistMutation(
    project: EditorProject,
    expectedRevision: number,
  ): Promise<EditorProject> {
    if (project.origin === "saved-example") {
      return this.saveProject({ project, expectedRevision });
    }
    this.#writeDraft(project);
    return this.#remember(project);
  }

  #loadedProject(projectId: string): EditorProject {
    const project = this.#projects.get(projectId);
    if (!project) throw new Error(`Load project ${projectId} before editing it`);
    return project;
  }

  #requireRevision(project: EditorProject, expectedRevision: number): void {
    if (project.revision !== expectedRevision) {
      throw new EditorClientHttpError(
        `Revision conflict: expected ${expectedRevision}, current ${project.revision}`,
        409,
        { code: "revision_conflict", currentRevision: project.revision },
      );
    }
  }

  #remember(project: EditorProject): EditorProject {
    this.#projects.set(project.id, project);
    return project;
  }

  #writeDraft(project: EditorProject): void {
    if (project.origin !== "example" || !project.example_slug) return;
    try {
      this.#storage()?.setItem(draftKey(project.example_slug), JSON.stringify(project));
    } catch {
      // Privacy settings and full browser storage must not block editing.
    }
  }

  #readDraft(slug: string): string | null {
    try {
      return this.#storage()?.getItem(draftKey(slug)) ?? null;
    } catch {
      return null;
    }
  }

  #removeDraft(slug: string): void {
    try {
      this.#storage()?.removeItem(draftKey(slug));
    } catch {
      // The immutable example can still be reloaded when storage is unavailable.
    }
  }

  #storage(): DraftStorage | null {
    try {
      if (this.#storageOverride !== undefined) return this.#storageOverride;
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }
}

export const hostedEditorClient = new HostedEditorClient();
