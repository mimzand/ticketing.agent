CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`default_priority` text NOT NULL,
	`active` integer NOT NULL,
	`examples` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `category_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `replaced_category_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `priority` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `replaced_priority` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `priority_reviewed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `category_reviewed` integer DEFAULT 0 NOT NULL;
