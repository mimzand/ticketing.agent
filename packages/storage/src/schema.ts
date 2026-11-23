import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const departments = sqliteTable('departments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
});

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  channel: text('channel').notNull(),
  createdAt: text('created_at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  ticketId: text('ticket_id')
    .primaryKey()
    .references(() => tickets.id),
  departmentId: text('department_id'),
  confidence: real('confidence').notNull(),
  rationale: text('rationale').notNull(),
  status: text('status').notNull(),
});
