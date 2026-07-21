import { getD1 } from "@/db";
import {
  MAX_SAVED_PROJECTS_PER_OWNER,
  type CreateSavedProjectInput,
  type PatchSavedProjectInput,
  type SavedProject,
  type SavedProjectSummary,
  parseStoredDocument,
} from "./domain";
import {
  CREATE_SAVED_PROJECT_SQL,
  DELETE_SAVED_PROJECT_SQL,
  GET_SAVED_PROJECT_SQL,
  LIST_SAVED_PROJECTS_SQL,
  UPDATE_SAVED_PROJECT_SQL,
} from "./sql";

type ProjectSummaryRow = {
  id: string;
  exampleSlug: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = ProjectSummaryRow & {
  documentJson: string;
};

export class SavedProjectLimitError extends Error {
  constructor() {
    super(`You can save up to ${MAX_SAVED_PROJECTS_PER_OWNER} projects`);
    this.name = "SavedProjectLimitError";
  }
}

export class SavedProjectConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("This project was updated elsewhere");
    this.name = "SavedProjectConflictError";
    this.currentRevision = currentRevision;
  }
}

export async function listSavedProjects(
  ownerId: string,
): Promise<SavedProjectSummary[]> {
  const result = await getD1()
    .prepare(LIST_SAVED_PROJECTS_SQL)
    .bind(ownerId)
    .all<ProjectSummaryRow>();
  return result.results;
}

export async function getSavedProject(
  ownerId: string,
  id: string,
): Promise<SavedProject | null> {
  const row = await getD1()
    .prepare(GET_SAVED_PROJECT_SQL)
    .bind(ownerId, id)
    .first<ProjectRow>();
  return row ? toProject(row) : null;
}

export async function createSavedProject(
  ownerId: string,
  input: CreateSavedProjectInput,
): Promise<SavedProject> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(CREATE_SAVED_PROJECT_SQL)
    .bind(
      id,
      ownerId,
      input.exampleSlug,
      input.title,
      input.documentJson,
      now,
      now,
      ownerId,
      MAX_SAVED_PROJECTS_PER_OWNER,
    )
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    throw new SavedProjectLimitError();
  }

  const project = await getSavedProject(ownerId, id);
  if (!project) throw new Error("Saved project insert could not be read back");
  return project;
}

export async function updateSavedProject(
  ownerId: string,
  id: string,
  input: PatchSavedProjectInput,
): Promise<SavedProject | null> {
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(UPDATE_SAVED_PROJECT_SQL)
    .bind(
      input.title ?? null,
      input.documentJson ?? null,
      now,
      ownerId,
      id,
      input.expectedRevision,
    )
    .run();

  if ((result.meta.changes ?? 0) === 1) {
    const project = await getSavedProject(ownerId, id);
    if (!project) throw new Error("Saved project update could not be read back");
    return project;
  }

  const current = await getSavedProject(ownerId, id);
  if (!current) return null;
  throw new SavedProjectConflictError(current.revision);
}

export async function deleteSavedProject(
  ownerId: string,
  id: string,
): Promise<boolean> {
  const result = await getD1()
    .prepare(DELETE_SAVED_PROJECT_SQL)
    .bind(ownerId, id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

function toProject(row: ProjectRow): SavedProject {
  return {
    id: row.id,
    exampleSlug: row.exampleSlug,
    title: row.title,
    revision: row.revision,
    document: parseStoredDocument(row.documentJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
