ALTER TABLE `departments` ADD `aliases` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `departments` ADD `examples` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `quote` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `taxonomy_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `taxonomy_versions` (
	`version` integer PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`department_count` integer NOT NULL,
	`snapshot` text NOT NULL
);
