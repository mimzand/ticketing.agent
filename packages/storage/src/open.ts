import {
  DecisionSchema,
  DepartmentSchema,
  TicketViewSchema,
  type ClassifyTicket,
  type CreateDepartment,
  type Decision,
  type Department,
  type TicketView,
} from '@ticket/shared';
import BetterSqlite3 from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { decisions, departments, tickets } from './schema.js';

export const RECENT_TICKET_LIMIT = 50;

export interface TicketDatabase {
  listDepartments(): readonly Department[];
  /** Inserts an active department. Throws when the id already exists. */
  insertDepartment(input: CreateDepartment): Department;
  findByExternalId(externalId: string): TicketView | null;
  /** Inserts the ticket row only. The host stores the decision afterwards. */
  insertTicket(input: ClassifyTicket): { readonly id: string; readonly createdAt: string };
  saveDecision(ticketId: string, decision: Decision): void;
  getById(id: string): TicketView | null;
  listRecent(): readonly TicketView[];
  close(): void;
}

type Database = BetterSQLite3Database<{
  departments: typeof departments;
  tickets: typeof tickets;
  decisions: typeof decisions;
}>;

interface TicketRow {
  readonly id: string;
  readonly externalId: string;
  readonly subject: string;
  readonly body: string;
  readonly channel: string;
  readonly createdAt: string;
  readonly departmentId: string | null;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: string;
}

function toView(row: TicketRow): TicketView {
  return TicketViewSchema.parse({
    id: row.id,
    externalId: row.externalId,
    subject: row.subject,
    body: row.body,
    channel: row.channel,
    createdAt: row.createdAt,
    decision: DecisionSchema.parse({
      departmentId: row.departmentId,
      confidence: row.confidence,
      rationale: row.rationale,
      status: row.status,
    }),
  });
}

const ticketQuery = (db: Database) =>
  db
    .select({
      id: tickets.id,
      externalId: tickets.externalId,
      subject: tickets.subject,
      body: tickets.body,
      channel: tickets.channel,
      createdAt: tickets.createdAt,
      departmentId: decisions.departmentId,
      confidence: decisions.confidence,
      rationale: decisions.rationale,
      status: decisions.status,
    })
    .from(tickets)
    .innerJoin(decisions, eq(decisions.ticketId, tickets.id));

/** Opens the file, creates parent directories, and applies the Drizzle migrations. */
export function openTicketDatabase(filePath: string): TicketDatabase {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new BetterSqlite3(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { departments, tickets, decisions } });
  migrate(db, { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') });

  return {
    listDepartments() {
      return db
        .select()
        .from(departments)
        .all()
        .map((row) => DepartmentSchema.parse(row));
    },
    insertDepartment(input) {
      const row = DepartmentSchema.parse({ ...input, active: true });
      db.insert(departments).values(row).run();
      return row;
    },
    findByExternalId(externalId) {
      const row = ticketQuery(db).where(eq(tickets.externalId, externalId)).get();
      return row ? toView(row) : null;
    },
    insertTicket(input) {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.insert(tickets)
        .values({
          id,
          externalId: input.externalId,
          subject: input.subject,
          body: input.body,
          channel: input.channel,
          createdAt,
        })
        .run();
      return { id, createdAt };
    },
    saveDecision(ticketId, decision) {
      const parsed = DecisionSchema.parse(decision);
      const values = {
        ticketId,
        departmentId: parsed.departmentId,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
        status: parsed.status,
      };
      db.insert(decisions)
        .values(values)
        .onConflictDoUpdate({
          target: decisions.ticketId,
          set: {
            departmentId: values.departmentId,
            confidence: values.confidence,
            rationale: values.rationale,
            status: values.status,
          },
        })
        .run();
    },
    getById(id) {
      const row = ticketQuery(db).where(eq(tickets.id, id)).get();
      return row ? toView(row) : null;
    },
    listRecent() {
      return ticketQuery(db)
        .orderBy(desc(tickets.createdAt))
        .limit(RECENT_TICKET_LIMIT)
        .all()
        .map((row) => toView(row));
    },
    close() {
      sqlite.close();
    },
  };
}
