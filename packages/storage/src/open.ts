import {
  DecisionSchema,
  DepartmentSchema,
  TicketViewSchema,
  type ClassifyTicket,
  CreateDepartmentSchema,
  type CreateDepartmentInput,
  type Department,
  type SettingsPatch,
  type SettingsValues,
  SettingsValuesSchema,
  TaxonomyStateSchema,
  normalizeEmail,
  PriorTicketSchema,
  OverrideFeedbackItemSchema,
  SENDER_HISTORY_LIMIT,
  type PriorTicket,
  type OverrideFeedbackItem,
  type TaxonomyState,
  type TicketView,
  type UpdateDepartment,
  CategorySchema,
  CreateCategorySchema,
  PriorityAggregateSchema,
  TicketPrioritySchema,
  type Category,
  type CreateCategoryInput,
  type PriorityAggregate,
  type TicketPriority,
  type UpdateCategory,
} from '@ticket/shared';
import BetterSqlite3 from 'better-sqlite3';
import { type z } from 'zod';
import { and, count, desc, eq, isNotNull, lt, max, ne, or } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { categories, decisions, departments, senders, settings, taxonomyVersions, tickets } from './schema.js';

export const RECENT_TICKET_LIMIT = 50;

/**
 * What a classify stores: the department fields, plus the category and priority the
 * host accepted (missing means null). The admin review columns are never written here.
 */
export const SaveDecisionSchema = DecisionSchema.pick({
  departmentId: true,
  confidence: true,
  rationale: true,
  status: true,
  quote: true,
  taxonomyVersion: true,
}).extend({
  categoryId: DecisionSchema.shape.categoryId.default(null),
  priority: DecisionSchema.shape.priority.default(null),
});
export type SaveDecisionInput = z.input<typeof SaveDecisionSchema>;

export interface TicketDatabase {
  listDepartments(): readonly Department[];
  /**
   * Inserts an active department and records a new taxonomy version, in one
   * transaction. Throws when the id already exists.
   */
  insertDepartment(input: CreateDepartmentInput): Department;
  /**
   * Changes name, description, active, aliases, or examples. The id never changes.
   * A real change records a new taxonomy version; an edit that changes nothing does not.
   * Null when no such row.
   */
  updateDepartment(input: UpdateDepartment): Department | null;
  /**
   * Deletes the row only when no decision references its id, and records a new
   * taxonomy version, in one transaction. Tickets and decisions are never touched.
   */
  deleteDepartment(id: string): 'deleted' | 'referenced' | 'missing';
  /** The current taxonomy version: 0 until the first department exists. */
  taxonomyVersion(): number;
  /** The current version and every recorded version, newest first. */
  taxonomy(): TaxonomyState;
  /** Saved non-secret settings. A stored value that no longer validates is ignored. */
  readSettings(): Partial<SettingsValues>;
  /** Saves validated values in one transaction. */
  writeSettings(patch: SettingsPatch): void;
  counts(): { readonly departments: number; readonly tickets: number };
  findByExternalId(externalId: string): TicketView | null;
  /**
   * Stores the ticket row only; the host stores the decision afterwards. If a row for
   * this externalId exists without a decision (a classify that crashed or was cancelled
   * before its decision was saved), that row is reused with the new text instead of
   * failing the unique constraint. Throws if the externalId already has a decision.
   */
  insertTicket(input: ClassifyTicket): { readonly id: string; readonly createdAt: string };
  /**
   * Links a ticket that has no sender to `email` (found or created). A ticket that
   * already has a sender is left as it is. Returns whether it changed anything.
   */
  attachEmail(ticketId: string, email: string): boolean;
  /**
   * The sender's most recent decided tickets, newest first, at most 5. With
   * `before`, only tickets older than that ticket (and never that ticket itself).
   * Never a body or a rationale.
   */
  priorTickets(email: string, before?: { readonly id: string; readonly createdAt: string }): PriorTicket[];
  /**
   * Moves every ticket of `from` onto `into` (created if needed) and removes `from`.
   * Decisions are not touched. `null` when `from` has no sender row.
   */
  mergeSenders(from: string, into: string): { readonly email: string; readonly movedTickets: number } | null;
  /** Removes a ticket row that has no decision (e.g. a cancelled classify). Decided rows are kept. */
  discardUndecided(ticketId: string): void;
  /**
   * Writes a classifier decision (department fields, category, priority). Never
   * touches the replaced department, the replaced category or priority, or the
   * admin review flags.
   */
  saveDecision(ticketId: string, decision: SaveDecisionInput): void;
  /**
   * Admin category: the first time, the category on the row at that moment (or null)
   * becomes the replaced category and the decision is marked category-reviewed; later
   * calls change only the category. Department fields and priority are untouched.
   * `false` when the ticket has no decision.
   */
  setCategory(ticketId: string, categoryId: string): boolean;
  /**
   * Admin priority, same rule: the first time, the priority on the row (or null)
   * becomes the replaced priority and the decision is marked priority-reviewed;
   * later calls change only the priority. Confirming the same value still counts.
   */
  setPriority(ticketId: string, priority: TicketPriority): boolean;
  /**
   * Decision counts grouped by final category, final priority, replaced priority, and
   * the priority-review flag. Counts only: no ticket text, no sender.
   */
  priorityAggregates(): PriorityAggregate[];
  listCategories(): readonly Category[];
  /** Inserts an active category. Throws when the id exists. Taxonomy versions are not touched. */
  insertCategory(input: CreateCategoryInput): Category;
  /** Null when no such row. The id never changes. */
  updateCategory(input: UpdateCategory): Category | null;
  /** Refused while any decision stores the id as its category or replaced category. */
  deleteCategory(id: string): 'deleted' | 'referenced' | 'missing';
  /**
   * An operator override, in one transaction: the first time a decision becomes
   * `overridden`, the department on the row at that moment (or null) is kept as the
   * replaced department; later overrides change only the department. Confidence,
   * rationale, quote, and taxonomy version are left as they are. `false` when the
   * ticket has no decision.
   */
  overrideDecision(ticketId: string, departmentId: string): boolean;
  /**
   * Decided tickets whose first override replaced a classifier department
   * (`replaced_department_id` not null), newest first, at most `limit`. No sender:
   * the email is never part of these rows.
   */
  overrideFeedback(limit: number): OverrideFeedbackItem[];
  getById(id: string): TicketView | null;
  listRecent(): readonly TicketView[];
  close(): void;
}

type Database = BetterSQLite3Database<{
  departments: typeof departments;
  tickets: typeof tickets;
  decisions: typeof decisions;
  settings: typeof settings;
  taxonomyVersions: typeof taxonomyVersions;
  senders: typeof senders;
  categories: typeof categories;
}>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The sender row for a normalized email, created when missing. */
function senderIdFor(tx: Tx, rawEmail: string): string {
  const email = normalizeEmail(rawEmail);
  const found = tx.select({ id: senders.id }).from(senders).where(eq(senders.email, email)).get();
  if (found) return found.id;
  const id = randomUUID();
  tx.insert(senders).values({ id, email, createdAt: new Date().toISOString() }).run();
  return id;
}

interface DepartmentRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly aliases: string;
  readonly examples: string;
}

const parseList = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return [];
  }
};

function toDepartment(row: DepartmentRow): Department {
  return DepartmentSchema.parse({ ...row, aliases: parseList(row.aliases), examples: parseList(row.examples) });
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultPriority: string;
  readonly active: boolean;
  readonly examples: string;
}

function toCategory(row: CategoryRow): Category {
  return CategorySchema.parse({ ...row, examples: parseList(row.examples) });
}

function toCategoryRow(category: Category): CategoryRow {
  return { ...category, examples: JSON.stringify(category.examples) };
}

function toRow(department: Department): DepartmentRow {
  return {
    ...department,
    aliases: JSON.stringify(department.aliases),
    examples: JSON.stringify(department.examples),
  };
}

/** Records the catalogue as it is now under the next version number. */
function recordVersion(tx: Tx): number {
  const catalogue = tx
    .select()
    .from(departments)
    .orderBy(departments.id)
    .all()
    .map((row) => toDepartment(row));
  const latest = tx.select({ v: max(taxonomyVersions.version) }).from(taxonomyVersions).get()?.v ?? 0;
  const version = latest + 1;
  tx.insert(taxonomyVersions)
    .values({
      version,
      createdAt: new Date().toISOString(),
      departmentCount: catalogue.length,
      snapshot: JSON.stringify(catalogue),
    })
    .run();
  return version;
}

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
  readonly quote: string | null;
  readonly taxonomyVersion: number;
  readonly categoryId: string | null;
  readonly replacedCategoryId: string | null;
  readonly categoryReviewed: boolean;
  readonly priority: string | null;
  readonly replacedPriority: string | null;
  readonly priorityReviewed: boolean;
  readonly email: string | null;
}

function toView(row: TicketRow): TicketView {
  return TicketViewSchema.parse({
    id: row.id,
    externalId: row.externalId,
    subject: row.subject,
    body: row.body,
    channel: row.channel,
    createdAt: row.createdAt,
    email: row.email,
    decision: DecisionSchema.parse({
      departmentId: row.departmentId,
      confidence: row.confidence,
      rationale: row.rationale,
      status: row.status,
      quote: row.quote,
      taxonomyVersion: row.taxonomyVersion,
      categoryId: row.categoryId,
      replacedCategoryId: row.replacedCategoryId,
      categoryReviewed: row.categoryReviewed,
      priority: row.priority,
      replacedPriority: row.replacedPriority,
      priorityReviewed: row.priorityReviewed,
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
      quote: decisions.quote,
      taxonomyVersion: decisions.taxonomyVersion,
      categoryId: decisions.categoryId,
      replacedCategoryId: decisions.replacedCategoryId,
      categoryReviewed: decisions.categoryReviewed,
      priority: decisions.priority,
      replacedPriority: decisions.replacedPriority,
      priorityReviewed: decisions.priorityReviewed,
      email: senders.email,
    })
    .from(tickets)
    .innerJoin(decisions, eq(decisions.ticketId, tickets.id))
    .leftJoin(senders, eq(senders.id, tickets.senderId));

/**
 * `packages/storage/drizzle` when running from source; `drizzle/` next to the bundle
 * when the desktop runs the built agent (`apps/desktop/out/agent`).
 */
function migrationsFolder(): string {
  const source = join(import.meta.dirname, '..', 'drizzle');
  const bundled = join(import.meta.dirname, 'drizzle');
  return existsSync(join(source, 'meta', '_journal.json')) || !existsSync(join(bundled, 'meta', '_journal.json'))
    ? source
    : bundled;
}

/** Opens the file, creates parent directories, and applies the Drizzle migrations. */
export function openTicketDatabase(filePath: string): TicketDatabase {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new BetterSqlite3(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { departments, tickets, decisions, settings, taxonomyVersions, senders, categories } });
  migrate(db, { migrationsFolder: migrationsFolder() });
  // A database from before taxonomy versions that already has departments gets a
  // baseline version 1. Older decisions keep version 0 (unknown).
  db.transaction((tx) => {
    const hasVersions = (tx.select({ n: count() }).from(taxonomyVersions).get()?.n ?? 0) > 0;
    const hasDepartments = (tx.select({ n: count() }).from(departments).get()?.n ?? 0) > 0;
    if (!hasVersions && hasDepartments) recordVersion(tx);
  });

  return {
    listDepartments() {
      return db
        .select()
        .from(departments)
        .all()
        .map((row) => toDepartment(row));
    },
    insertDepartment(input) {
      const department = DepartmentSchema.parse({ ...CreateDepartmentSchema.parse(input), active: true });
      db.transaction((tx) => {
        tx.insert(departments).values(toRow(department)).run();
        recordVersion(tx);
      });
      return department;
    },
    updateDepartment(input) {
      return db.transaction((tx) => {
        const row = tx.select().from(departments).where(eq(departments.id, input.id)).get();
        if (!row) return null;
        const current = toDepartment(row);
        const next = DepartmentSchema.parse({
          id: current.id,
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          active: input.active ?? current.active,
          aliases: input.aliases ?? current.aliases,
          examples: input.examples ?? current.examples,
        });
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        const { id: _id, ...changes } = toRow(next);
        tx.update(departments).set(changes).where(eq(departments.id, current.id)).run();
        recordVersion(tx);
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
        recordVersion(tx);
        return 'deleted' as const;
      });
    },
    taxonomyVersion() {
      return db.select({ v: max(taxonomyVersions.version) }).from(taxonomyVersions).get()?.v ?? 0;
    },
    taxonomy() {
      const history = db
        .select({
          version: taxonomyVersions.version,
          createdAt: taxonomyVersions.createdAt,
          departmentCount: taxonomyVersions.departmentCount,
        })
        .from(taxonomyVersions)
        .orderBy(desc(taxonomyVersions.version))
        .all();
      return TaxonomyStateSchema.parse({ current: history[0]?.version ?? 0, history });
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
      return db.transaction((tx) => {
        const createdAt = new Date().toISOString();
        const existing = tx
          .select({ id: tickets.id, decided: decisions.ticketId })
          .from(tickets)
          .leftJoin(decisions, eq(decisions.ticketId, tickets.id))
          .where(eq(tickets.externalId, input.externalId))
          .get();
        if (existing?.decided) throw new Error('This externalId already has a decision.');
        // The sender comes only from the email field, never from the subject or the body.
        const senderId = input.email ? senderIdFor(tx, input.email) : null;
        if (existing) {
          tx.update(tickets)
            .set({ subject: input.subject, body: input.body, channel: input.channel, createdAt, senderId })
            .where(eq(tickets.id, existing.id))
            .run();
          return { id: existing.id, createdAt };
        }
        const id = randomUUID();
        tx.insert(tickets)
          .values({
            id,
            externalId: input.externalId,
            subject: input.subject,
            body: input.body,
            channel: input.channel,
            createdAt,
            senderId,
          })
          .run();
        return { id, createdAt };
      });
    },
    attachEmail(ticketId, email) {
      return db.transaction((tx) => {
        const row = tx.select({ senderId: tickets.senderId }).from(tickets).where(eq(tickets.id, ticketId)).get();
        if (!row || row.senderId !== null) return false;
        tx.update(tickets).set({ senderId: senderIdFor(tx, email) }).where(eq(tickets.id, ticketId)).run();
        return true;
      });
    },
    priorTickets(email, before) {
      const filters = [eq(senders.email, normalizeEmail(email))];
      if (before) filters.push(ne(tickets.id, before.id), lt(tickets.createdAt, before.createdAt));
      return db
        .select({
          subject: tickets.subject,
          channel: tickets.channel,
          status: decisions.status,
          departmentId: decisions.departmentId,
          quote: decisions.quote,
          replacedDepartmentId: decisions.replacedDepartmentId,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .innerJoin(senders, eq(senders.id, tickets.senderId))
        .innerJoin(decisions, eq(decisions.ticketId, tickets.id))
        .where(and(...filters))
        .orderBy(desc(tickets.createdAt))
        .limit(SENDER_HISTORY_LIMIT)
        .all()
        .map((row) => PriorTicketSchema.parse(row));
    },
    mergeSenders(fromRaw, intoRaw) {
      const from = normalizeEmail(fromRaw);
      const into = normalizeEmail(intoRaw);
      return db.transaction((tx) => {
        const source = tx.select({ id: senders.id }).from(senders).where(eq(senders.email, from)).get();
        if (!source) return null;
        const targetId = senderIdFor(tx, into);
        const moved = tx
          .update(tickets)
          .set({ senderId: targetId })
          .where(eq(tickets.senderId, source.id))
          .run().changes;
        tx.delete(senders).where(eq(senders.id, source.id)).run();
        return { email: into, movedTickets: moved };
      });
    },
    discardUndecided(ticketId) {
      db.transaction((tx) => {
        const decided = tx.select({ id: decisions.ticketId }).from(decisions).where(eq(decisions.ticketId, ticketId)).get();
        if (!decided) tx.delete(tickets).where(eq(tickets.id, ticketId)).run();
      });
    },
    saveDecision(ticketId, decision) {
      const parsed = SaveDecisionSchema.parse(decision);
      const values = {
        ticketId,
        departmentId: parsed.departmentId,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
        status: parsed.status,
        quote: parsed.quote,
        taxonomyVersion: parsed.taxonomyVersion,
        categoryId: parsed.categoryId,
        priority: parsed.priority,
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
            quote: values.quote,
            taxonomyVersion: values.taxonomyVersion,
            categoryId: values.categoryId,
            priority: values.priority,
          },
        })
        .run();
    },
    setCategory(ticketId, categoryId) {
      return db.transaction((tx) => {
        const current = tx
          .select({ categoryId: decisions.categoryId, reviewed: decisions.categoryReviewed })
          .from(decisions)
          .where(eq(decisions.ticketId, ticketId))
          .get();
        if (!current) return false;
        tx.update(decisions)
          .set(
            current.reviewed
              ? { categoryId }
              : { categoryId, replacedCategoryId: current.categoryId, categoryReviewed: true },
          )
          .where(eq(decisions.ticketId, ticketId))
          .run();
        return true;
      });
    },
    setPriority(ticketId, priority) {
      const value = TicketPrioritySchema.parse(priority);
      return db.transaction((tx) => {
        const current = tx
          .select({ priority: decisions.priority, reviewed: decisions.priorityReviewed })
          .from(decisions)
          .where(eq(decisions.ticketId, ticketId))
          .get();
        if (!current) return false;
        tx.update(decisions)
          .set(
            current.reviewed
              ? { priority: value }
              : { priority: value, replacedPriority: current.priority, priorityReviewed: true },
          )
          .where(eq(decisions.ticketId, ticketId))
          .run();
        return true;
      });
    },
    priorityAggregates() {
      return db
        .select({
          categoryId: decisions.categoryId,
          priority: decisions.priority,
          replacedPriority: decisions.replacedPriority,
          reviewed: decisions.priorityReviewed,
          count: count(),
        })
        .from(decisions)
        .groupBy(decisions.categoryId, decisions.priority, decisions.replacedPriority, decisions.priorityReviewed)
        .all()
        .flatMap((row) => {
          // A value that no longer validates is left out rather than guessed.
          const parsed = PriorityAggregateSchema.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
    },
    listCategories() {
      return db
        .select()
        .from(categories)
        .orderBy(categories.id)
        .all()
        .map((row) => toCategory(row));
    },
    insertCategory(input) {
      const category = CategorySchema.parse({ ...CreateCategorySchema.parse(input), active: true });
      db.insert(categories).values(toCategoryRow(category)).run();
      return category;
    },
    updateCategory(input) {
      return db.transaction((tx) => {
        const row = tx.select().from(categories).where(eq(categories.id, input.id)).get();
        if (!row) return null;
        const current = toCategory(row);
        const next = CategorySchema.parse({
          id: current.id,
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          active: input.active ?? current.active,
          defaultPriority: input.defaultPriority ?? current.defaultPriority,
          examples: input.examples ?? current.examples,
        });
        const { id: _id, ...changes } = toCategoryRow(next);
        tx.update(categories).set(changes).where(eq(categories.id, current.id)).run();
        return next;
      });
    },
    deleteCategory(id) {
      return db.transaction((tx) => {
        const current = tx.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get();
        if (!current) return 'missing' as const;
        const used = tx
          .select({ n: count() })
          .from(decisions)
          .where(or(eq(decisions.categoryId, id), eq(decisions.replacedCategoryId, id)))
          .get();
        if ((used?.n ?? 0) > 0) return 'referenced' as const;
        tx.delete(categories).where(eq(categories.id, id)).run();
        return 'deleted' as const;
      });
    },
    overrideDecision(ticketId, departmentId) {
      return db.transaction((tx) => {
        const current = tx
          .select({ status: decisions.status, departmentId: decisions.departmentId })
          .from(decisions)
          .where(eq(decisions.ticketId, ticketId))
          .get();
        if (!current) return false;
        tx.update(decisions)
          .set(
            current.status === 'overridden'
              ? { departmentId }
              : { departmentId, status: 'overridden', replacedDepartmentId: current.departmentId },
          )
          .where(eq(decisions.ticketId, ticketId))
          .run();
        return true;
      });
    },
    overrideFeedback(limit) {
      return db
        .select({
          ticketId: tickets.id,
          externalId: tickets.externalId,
          subject: tickets.subject,
          body: tickets.body,
          channel: tickets.channel,
          createdAt: tickets.createdAt,
          replacedDepartmentId: decisions.replacedDepartmentId,
          departmentId: decisions.departmentId,
          status: decisions.status,
          confidence: decisions.confidence,
          rationale: decisions.rationale,
          quote: decisions.quote,
          taxonomyVersion: decisions.taxonomyVersion,
        })
        .from(tickets)
        .innerJoin(decisions, eq(decisions.ticketId, tickets.id))
        .where(and(isNotNull(decisions.replacedDepartmentId), isNotNull(decisions.departmentId)))
        .orderBy(desc(tickets.createdAt))
        .limit(limit)
        .all()
        .map((row) => OverrideFeedbackItemSchema.parse(row));
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
