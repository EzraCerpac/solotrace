import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const savedProjects = sqliteTable(
  "saved_projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    exampleSlug: text("example_slug").notNull(),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    documentJson: text("document_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("saved_projects_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt,
    ),
    check("saved_projects_revision_positive", sql`${table.revision} >= 1`),
  ],
);
