export const LIST_SAVED_PROJECTS_SQL = `SELECT
  id,
  example_slug AS exampleSlug,
  title,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM saved_projects
WHERE owner_id = ?
ORDER BY updated_at DESC, id DESC`;

export const GET_SAVED_PROJECT_SQL = `SELECT
  id,
  example_slug AS exampleSlug,
  title,
  revision,
  document_json AS documentJson,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM saved_projects
WHERE owner_id = ? AND id = ?`;

export const CREATE_SAVED_PROJECT_SQL = `INSERT INTO saved_projects (
  id, owner_id, example_slug, title, revision,
  document_json, created_at, updated_at
)
SELECT ?, ?, ?, ?, 1, ?, ?, ?
WHERE (
  SELECT COUNT(*) FROM saved_projects WHERE owner_id = ?
) < ?`;

export const UPDATE_SAVED_PROJECT_SQL = `UPDATE saved_projects
SET
  title = COALESCE(?, title),
  document_json = COALESCE(?, document_json),
  revision = revision + 1,
  updated_at = ?
WHERE owner_id = ? AND id = ? AND revision = ?`;

export const DELETE_SAVED_PROJECT_SQL =
  "DELETE FROM saved_projects WHERE owner_id = ? AND id = ?";
