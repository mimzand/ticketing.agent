CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_external_id_unique` ON `tickets` (`external_id`);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`ticket_id` text PRIMARY KEY NOT NULL,
	`department_id` text,
	`confidence` real NOT NULL,
	`rationale` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`)
);
