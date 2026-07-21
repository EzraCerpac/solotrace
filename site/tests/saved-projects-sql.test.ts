import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CREATE_SAVED_PROJECT_SQL,
  DELETE_SAVED_PROJECT_SQL,
  GET_SAVED_PROJECT_SQL,
  UPDATE_SAVED_PROJECT_SQL,
} from "../lib/server/saved-projects/sql.ts";

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migration = readFileSync(
    new URL("../drizzle/0000_saved_examples.sql", import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
  database.exec(migration);
  return database;
}

function insertProject(
  database: DatabaseSync,
  id: string,
  ownerId: string,
): number | bigint {
  return database
    .prepare(CREATE_SAVED_PROJECT_SQL)
    .run(
      id,
      ownerId,
      "northbound-lights",
      id,
      "{}",
      "2026-07-21T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z",
      ownerId,
      3,
    ).changes;
}

test("one atomic insert enforces the three-copy cap per owner", () => {
  const database = createDatabase();
  assert.equal(insertProject(database, "a-1", "owner-a"), 1);
  assert.equal(insertProject(database, "a-2", "owner-a"), 1);
  assert.equal(insertProject(database, "a-3", "owner-a"), 1);
  assert.equal(insertProject(database, "a-4", "owner-a"), 0);
  assert.equal(insertProject(database, "b-1", "owner-b"), 1);
});

test("detail, revision update, and delete statements are owner scoped", () => {
  const database = createDatabase();
  insertProject(database, "project", "owner-a");

  assert.equal(
    database.prepare(GET_SAVED_PROJECT_SQL).get("owner-b", "project"),
    undefined,
  );
  assert.equal(
    database
      .prepare(UPDATE_SAVED_PROJECT_SQL)
      .run("Stolen", null, "later", "owner-b", "project", 1).changes,
    0,
  );
  assert.equal(
    database
      .prepare(UPDATE_SAVED_PROJECT_SQL)
      .run("Mine", null, "later", "owner-a", "project", 1).changes,
    1,
  );
  assert.equal(
    database
      .prepare(UPDATE_SAVED_PROJECT_SQL)
      .run("Stale", null, "later", "owner-a", "project", 1).changes,
    0,
  );
  assert.equal(
    database.prepare(DELETE_SAVED_PROJECT_SQL).run("owner-b", "project")
      .changes,
    0,
  );
  assert.equal(
    database.prepare(DELETE_SAVED_PROJECT_SQL).run("owner-a", "project")
      .changes,
    1,
  );
});

test("migration enforces positive revisions", () => {
  const database = createDatabase();
  assert.throws(() =>
    database.exec(`INSERT INTO saved_projects (
      id, owner_id, example_slug, title, revision,
      document_json, created_at, updated_at
    ) VALUES ('bad', 'owner', 'low-orbit', 'Bad', 0, '{}', 'now', 'now')`),
  );
});
