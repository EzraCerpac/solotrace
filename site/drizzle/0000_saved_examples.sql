CREATE TABLE `saved_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`example_slug` text NOT NULL,
	`title` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`document_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "saved_projects_revision_positive" CHECK("saved_projects"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `saved_projects_owner_updated_idx` ON `saved_projects` (`owner_id`,`updated_at`);