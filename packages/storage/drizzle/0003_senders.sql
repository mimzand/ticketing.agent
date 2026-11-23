CREATE TABLE `senders` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `senders_email_unique` ON `senders` (`email`);
--> statement-breakpoint
ALTER TABLE `tickets` ADD `sender_id` text REFERENCES senders(id);
--> statement-breakpoint
CREATE INDEX `tickets_sender_id_idx` ON `tickets` (`sender_id`);
