import {
  DecisionSchema,
  DepartmentSchema,
  TicketViewSchema,
  type ClassifyTicket,
  type CreateDepartment,
  type Decision,
  type Department,
  type SettingsPatch,
  type SettingsValues,
  SettingsValuesSchema,
  type TicketView,
  type UpdateDepartment,
} from '@ticket/shared';
import BetterSqlite3 from 'better-sqlite3';
import { count, desc, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { decisions, departments, settings, tickets } from './schema.js';

export const RECENT_TICKET_LIMIT = 50;

export interface TicketDatabase {
  listDepartments(): readonly Department[];
  /** Inserts an active department. Throws when the id already exists. */
  insertDepartment(input: CreateDepartment): Department;
  /** Changes name, description, or active. The id never changes. Null when no such row. */
  updateDepartment(input: UpdateDepartment): Department | null;
  /**
   * Deletes the row only when no decision references its id, in one transaction.
   * Tickets and decisions are never touched.
   */
  deleteDepartment(id: string): 'deleted' | 'referenced' | 'missing';
  /** Saved non-secret settings. A stored value that no longer validates is ignored. */
  readSettings(): Partial<SettingsValues>;
  /** Saves validated values in one transaction. */
  writeSettings(patch: SettingsPatch): void;
  counts(): { readonly departments: number; readonly tickets: number };
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
  settings: typeof settings;
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
  const db = drizzle(sqlite, { schema: { departments, tickets, decisions, settings } });
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
    updateDepartment(input) {
      return db.transaction((tx) => {
        const current = tx.select().from(departments).where(eq(departments.id, input.id)).get();
        if (!current) return null;
        const next = DepartmentSchema.parse({
          id: current.id,
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          active: input.active ?? current.active,
        });
        tx.update(departments)
          .set({ name: next.name, description: next.description, active: next.active })
          .where(eq(departments.id, current.id))
          .run();
        return next;
      });
    },
    deleteDepartment(id) {
      return db.transaction((tx) => {
        const current = tx.select().from(departments).where(eq(departments.id, id)).get();
        if (!current) return 'missing' as const;
        const used = tx
          .select({ n: count() })
          .from(decisions)
          .where(eq(decisions.departmentId, id))
          .get();
        if ((used?.n ?? 0) > 0) return 'referenced' as const;
        tx.delete(departments).where(eq(departments.id, id)).run();
        return 'deleted' as const;
      });
    },
    readSettings() {
      const result: Record<string, unknown> = {};
      for (const row of db.select().from(settings).all()) {
        const schema = SettingsValuesSchema.shape[row.key as keyof SettingsValues] as
          | (typeof SettingsValuesSchema.shape)[keyof SettingsValues]
          | undefined;
        if (!schema) continue;
        try {
          const parsed = schema.safeParse(JSON.parse(row.value));
          if (parsed.success) result[row.key] = parsed.data;
        } catch {
          // Not JSON: ignore the row; the default or the environment applies.
        }
      }
      return result as Partial<SettingsValues>;
    },
    writeSettings(patch) {
      const values = SettingsValuesSchema.partial().parse(patch);
      db.transaction((tx) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) continue;
          const json = JSON.stringify(value);
          tx.insert(settings)
            .values({ key, value: json })
            .onConflictDoUpdate({ target: settings.key, set: { value: json } })
            .run();
        }
      });
    },
    counts() {
      const d = db.select({ n: count() }).from(departments).get();
      const t = db.select({ n: count() }).from(tickets).get();
      return { departments: d?.n ?? 0, tickets: t?.n ?? 0 };
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
