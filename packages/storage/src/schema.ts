import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const departments = sqliteTable('departments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  /** JSON array of strings. Unique across departments (case-insensitive). */
  aliases: text('aliases').notNull().default('[]'),
  /** JSON array of strings. */
  examples: text('examples').notNull().default('[]'),
});

/**
 * A sender is one normalized email address (trimmed, lowercased). Nothing else
 * identifies a person: not the channel, not the ticket text, not the model.
 */
export const senders = sqliteTable('senders', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  channel: text('channel').notNull(),
  createdAt: text('created_at').notNull(),
  /** The sender, or null for an unknown sender (no email). */
  senderId: text('sender_id').references(() => senders.id),
});

export const decisions = sqliteTable('decisions', {
  ticketId: text('ticket_id')
    .primaryKey()
    .references(() => tickets.id),
  departmentId: text('department_id'),
  confidence: real('confidence').notNull(),
  rationale: text('rationale').notNull(),
  status: text('status').notNull(),
  quote: text('quote'),
  taxonomyVersion: integer('taxonomy_version').notNull().default(0),
});

/**
 * One row per change to the department catalogue: a monotonic version and a JSON
 * snapshot (id, name, description, active, aliases, examples). Never rewritten.
 */
export const taxonomyVersions = sqliteTable('taxonomy_versions', {
  version: integer('version').primaryKey(),
  createdAt: text('created_at').notNull(),
  departmentCount: integer('department_count').notNull(),
  snapshot: text('snapshot').notNull(),
});

/** Non-secret settings, one JSON value per key. The Ollama access token is never stored. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
