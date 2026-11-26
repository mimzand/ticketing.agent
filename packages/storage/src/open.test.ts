import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { openTicketDatabase, type SaveDecisionInput, type TicketDatabase } from './open.js';

let db: TicketDatabase | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function open(): TicketDatabase {
  dir = mkdtempSync(join(tmpdir(), 'ticket-db-'));
  db = openTicketDatabase(join(dir, 'tickets.db'));
  return db;
}

describe('openTicketDatabase', () => {
  it('stores a department and rejects a repeated id', () => {
    const database = open();
    const created = database.insertDepartment({
      id: 'billing',
      name: 'Billing',
      description: 'Invoices',
    });
    expect(created.active).toBe(true);
    expect(database.listDepartments()).toEqual([created]);
    expect(() =>
      database.insertDepartment({ id: 'billing', name: 'Again', description: '' }),
    ).toThrow();
  });

  it('returns a ticket only after its decision is stored', () => {
    const database = open();
    const ticket = database.insertTicket({
      externalId: 'ext-1',
      subject: 'Printer',
      body: 'The printer is down.',
      channel: 'email',
    });
    expect(database.findByExternalId('ext-1')).toBeNull();
    database.saveDecision(ticket.id, {
      departmentId: 'billing',
      confidence: 0.91,
      rationale: 'Invoice wording.',
      status: 'labeled',
      quote: 'printer is down',
      taxonomyVersion: 1,
    });
    const stored = database.getById(ticket.id);
    expect(stored?.externalId).toBe('ext-1');
    expect(stored?.decision.status).toBe('labeled');
    expect(database.listRecent()).toHaveLength(1);
  });
});

describe('taxonomy versions', () => {
  it('starts at 0 with no department and records a snapshot for every change', () => {
    const database = open();
    expect(database.taxonomy()).toEqual({ current: 0, history: [] });
    database.insertDepartment({ id: 'billing', name: 'Billing', description: '', aliases: ['Invoices'] });
    expect(database.taxonomyVersion()).toBe(1);
    database.updateDepartment({ id: 'billing', examples: ['My invoice is wrong'] });
    expect(database.taxonomyVersion()).toBe(2);
    // An edit that changes nothing is not a new version.
    database.updateDepartment({ id: 'billing', name: 'Billing' });
    expect(database.taxonomyVersion()).toBe(2);
    database.insertDepartment({ id: 'spare', name: 'Spare', description: '' });
    expect(database.deleteDepartment('spare')).toBe('deleted');
    const state = database.taxonomy();
    expect(state.current).toBe(4);
    expect(state.history.map((v) => [v.version, v.departmentCount])).toEqual([
      [4, 1],
      [3, 2],
      [2, 1],
      [1, 1],
    ]);
    expect(database.listDepartments()).toEqual([
      {
        id: 'billing',
        name: 'Billing',
        description: '',
        active: true,
        aliases: ['Invoices'],
        examples: ['My invoice is wrong'],
      },
    ]);
  });
});

/** The category and priority fields of a decision nobody set. */
const NO_CATEGORY = {
  categoryId: null,
  replacedCategoryId: null,
  categoryReviewed: false,
  priority: null,
  replacedPriority: null,
  priorityReviewed: false,
} as const;

describe('replaced department', () => {
  const decision: SaveDecisionInput = {
    departmentId: 'billing',
    confidence: 0.9,
    rationale: 'Invoice.',
    status: 'labeled',
    quote: 'Invoice 18',
    taxonomyVersion: 1,
  };

  function decided(database: TicketDatabase, externalId: string, value: SaveDecisionInput = decision) {
    const ticket = database.insertTicket({ externalId, subject: 'Invoice 18', body: 'x', channel: 'email', email: 'ann@example.com' });
    database.saveDecision(ticket.id, value);
    return ticket;
  }

  it('classify stores null; the first override keeps the classifier department; later ones do not change it', () => {
    const database = open();
    const ticket = decided(database, 'r-1');
    expect(database.priorTickets('ann@example.com')[0]?.replacedDepartmentId).toBeNull();

    expect(database.overrideDecision(ticket.id, 'it')).toBe(true);
    expect(database.priorTickets('ann@example.com')[0]).toMatchObject({
      departmentId: 'it',
      status: 'overridden',
      quote: 'Invoice 18',
      replacedDepartmentId: 'billing',
    });
    expect(database.getById(ticket.id)?.decision).toEqual({ ...decision, departmentId: 'it', status: 'overridden', ...NO_CATEGORY });

    database.overrideDecision(ticket.id, 'hr');
    expect(database.priorTickets('ann@example.com')[0]).toMatchObject({ departmentId: 'hr', replacedDepartmentId: 'billing' });

    // saveDecision never writes (or clears) the column.
    database.saveDecision(ticket.id, { ...decision, departmentId: 'hr', status: 'overridden' });
    expect(database.priorTickets('ann@example.com')[0]?.replacedDepartmentId).toBe('billing');
  });

  it('an override of a decision with no department stores null', () => {
    const database = open();
    const ticket = decided(database, 'r-2', { ...decision, departmentId: null, status: 'needs_review', quote: null });
    database.overrideDecision(ticket.id, 'it');
    expect(database.priorTickets('ann@example.com')[0]).toMatchObject({ departmentId: 'it', replacedDepartmentId: null });
  });

  it('refuses a ticket with no decision', () => {
    const database = open();
    const ticket = database.insertTicket({ externalId: 'r-3', subject: 's', body: 'b', channel: 'email' });
    expect(database.overrideDecision(ticket.id, 'it')).toBe(false);
  });

  it('a database from before the column migrates; old decisions report null', () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-db-'));
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const older = join(dir, 'drizzle');
    mkdirSync(join(older, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const kept = journal.entries.filter((entry) => entry.idx <= 3);
    expect(kept.map((entry) => entry.tag)).toEqual(['0000_init', '0001_settings', '0002_taxonomy', '0003_senders']);
    for (const entry of kept) copyFileSync(join(source, `${entry.tag}.sql`), join(older, `${entry.tag}.sql`));
    writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));

    const path = join(dir, 'tickets.db');
    const raw = new BetterSqlite3(path);
    migrate(drizzle(raw), { migrationsFolder: older });
    const columns = raw.prepare('PRAGMA table_info(decisions)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('replaced_department_id');
    const at = '2026-01-01T00:00:00.000Z';
    raw.prepare('INSERT INTO senders (id, email, created_at) VALUES (?, ?, ?)').run('s1', 'ann@example.com', at);
    raw
      .prepare('INSERT INTO tickets (id, external_id, subject, body, channel, created_at, sender_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('00000000-0000-4000-8000-000000000001', 'old-1', 'Old invoice', 'x', 'email', at, 's1');
    raw
      .prepare(
        'INSERT INTO decisions (ticket_id, department_id, confidence, rationale, status, quote, taxonomy_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('00000000-0000-4000-8000-000000000001', 'it', 0.9, 'Was overridden.', 'overridden', null, 0);
    raw.close();

    db = openTicketDatabase(path);
    expect(db.priorTickets('ann@example.com')).toEqual([
      {
        subject: 'Old invoice',
        channel: 'email',
        status: 'overridden',
        departmentId: 'it',
        quote: null,
        replacedDepartmentId: null,
        createdAt: at,
      },
    ]);
    // Already overridden: a new override does not invent a replaced department.
    db.overrideDecision('00000000-0000-4000-8000-000000000001', 'hr');
    expect(db.priorTickets('ann@example.com')[0]).toMatchObject({ departmentId: 'hr', replacedDepartmentId: null });
  });
});

describe('categories and priority', () => {
  const labeled: SaveDecisionInput = {
    departmentId: 'billing',
    confidence: 0.9,
    rationale: 'Invoice.',
    status: 'labeled',
    quote: 'Invoice 18',
    taxonomyVersion: 1,
  };

  function ticketWith(database: TicketDatabase, externalId: string, value: SaveDecisionInput) {
    const ticket = database.insertTicket({ externalId, subject: 'Invoice 18', body: 'x', channel: 'email' });
    database.saveDecision(ticket.id, value);
    return ticket;
  }

  it('creates, lists, edits, and deactivates categories without touching the taxonomy version', () => {
    const database = open();
    const created = database.insertCategory({ id: 'outage', name: 'Outage', description: 'Down', defaultPriority: 'urgent' });
    expect(created).toEqual({
      id: 'outage',
      name: 'Outage',
      description: 'Down',
      active: true,
      defaultPriority: 'urgent',
      examples: [],
    });
    expect(() => database.insertCategory({ id: 'outage', name: 'x', description: '', defaultPriority: 'low' })).toThrow();
    expect(database.updateCategory({ id: 'outage', active: false, examples: ['Site is down'], defaultPriority: 'high' })).toEqual({
      ...created,
      active: false,
      defaultPriority: 'high',
      examples: ['Site is down'],
    });
    expect(database.updateCategory({ id: 'nope', active: false })).toBeNull();
    expect(database.listCategories().map((c) => c.id)).toEqual(['outage']);
    expect(database.taxonomyVersion()).toBe(0);
  });

  it('classify stores category and priority; review flags start false', () => {
    const database = open();
    const ticket = ticketWith(database, 'c-1', { ...labeled, categoryId: 'outage', priority: 'high' });
    expect(database.getById(ticket.id)?.decision).toEqual({
      ...labeled,
      categoryId: 'outage',
      replacedCategoryId: null,
      categoryReviewed: false,
      priority: 'high',
      replacedPriority: null,
      priorityReviewed: false,
    });
    // Missing category and priority are stored as null.
    const bare = ticketWith(database, 'c-2', labeled);
    expect(database.getById(bare.id)?.decision).toEqual({ ...labeled, ...NO_CATEGORY });
  });

  it('the first admin write keeps the model value; later writes change only the value; the other fields stay', () => {
    const database = open();
    const ticket = ticketWith(database, 'c-1', { ...labeled, categoryId: 'billing-error', priority: 'normal' });

    expect(database.setCategory(ticket.id, 'outage')).toBe(true);
    expect(database.setCategory(ticket.id, 'hardware')).toBe(true);
    expect(database.setPriority(ticket.id, 'high')).toBe(true);
    expect(database.setPriority(ticket.id, 'urgent')).toBe(true);
    expect(database.getById(ticket.id)?.decision).toEqual({
      ...labeled,
      categoryId: 'hardware',
      replacedCategoryId: 'billing-error',
      categoryReviewed: true,
      priority: 'urgent',
      replacedPriority: 'normal',
      priorityReviewed: true,
    });
    // A later classifier save does not clear the review columns.
    database.saveDecision(ticket.id, { ...labeled, categoryId: 'hardware', priority: 'urgent' });
    expect(database.getById(ticket.id)?.decision).toMatchObject({
      replacedCategoryId: 'billing-error',
      categoryReviewed: true,
      replacedPriority: 'normal',
      priorityReviewed: true,
    });
    expect(database.setCategory('00000000-0000-4000-8000-00000000ffff', 'x')).toBe(false);
    expect(database.setPriority('00000000-0000-4000-8000-00000000ffff', 'low')).toBe(false);
  });

  it('confirming the model value counts as a review, with that value as the replaced one; the two writes are independent', () => {
    const database = open();
    const ticket = ticketWith(database, 'c-1', { ...labeled, priority: 'high' });
    database.setPriority(ticket.id, 'high');
    expect(database.getById(ticket.id)?.decision).toMatchObject({
      priority: 'high',
      replacedPriority: 'high',
      priorityReviewed: true,
      categoryId: null,
      replacedCategoryId: null,
      categoryReviewed: false,
    });
    database.setCategory(ticket.id, 'outage');
    expect(database.getById(ticket.id)?.decision).toMatchObject({
      categoryId: 'outage',
      replacedCategoryId: null,
      categoryReviewed: true,
      priority: 'high',
      replacedPriority: 'high',
    });
  });

  it('refuses to delete a category any decision stores, as the category or the replaced one', () => {
    const database = open();
    for (const id of ['outage', 'hardware', 'spare']) {
      database.insertCategory({ id, name: id, description: '', defaultPriority: 'normal' });
    }
    const ticket = ticketWith(database, 'c-1', { ...labeled, categoryId: 'outage' });
    database.setCategory(ticket.id, 'hardware');
    expect(database.deleteCategory('outage')).toBe('referenced');
    expect(database.deleteCategory('hardware')).toBe('referenced');
    expect(database.deleteCategory('spare')).toBe('deleted');
    expect(database.deleteCategory('spare')).toBe('missing');
  });

  it('aggregates counts by final category, priority, model priority, and the review flag', () => {
    const database = open();
    const a = ticketWith(database, 'a', { ...labeled, categoryId: 'outage', priority: 'normal' });
    const b = ticketWith(database, 'b', { ...labeled, categoryId: 'outage', priority: 'normal' });
    ticketWith(database, 'c', { ...labeled, categoryId: 'outage', priority: 'normal' });
    database.setPriority(a.id, 'urgent');
    database.setPriority(b.id, 'urgent');
    const sorted = [...database.priorityAggregates()].sort((x, y) => Number(x.reviewed) - Number(y.reviewed));
    expect(sorted).toEqual([
      { categoryId: 'outage', priority: 'normal', replacedPriority: null, reviewed: false, count: 1 },
      { categoryId: 'outage', priority: 'urgent', replacedPriority: 'normal', reviewed: true, count: 2 },
    ]);
  });

  it('a database from before 0005 migrates; old decisions read null categories and priorities, flags false', () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-db-'));
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const older = join(dir, 'drizzle');
    mkdirSync(join(older, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const kept = journal.entries.filter((entry) => entry.idx <= 4);
    expect(kept.at(-1)?.tag).toBe('0004_replaced_department');
    for (const entry of kept) copyFileSync(join(source, `${entry.tag}.sql`), join(older, `${entry.tag}.sql`));
    writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));

    const path = join(dir, 'tickets.db');
    const raw = new BetterSqlite3(path);
    migrate(drizzle(raw), { migrationsFolder: older });
    const id = '00000000-0000-4000-8000-000000000002';
    raw
      .prepare('INSERT INTO tickets (id, external_id, subject, body, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'old-2', 'Old', 'x', 'email', '2026-01-01T00:00:00.000Z');
    raw
      .prepare(
        'INSERT INTO decisions (ticket_id, department_id, confidence, rationale, status, quote, taxonomy_version, replaced_department_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, 'it', 0.9, 'r', 'overridden', null, 1, 'billing');
    raw.close();

    db = openTicketDatabase(path);
    expect(db.getById(id)?.decision).toEqual({
      departmentId: 'it',
      confidence: 0.9,
      rationale: 'r',
      status: 'overridden',
      quote: null,
      taxonomyVersion: 1,
      ...NO_CATEGORY,
    });
    expect(db.listCategories()).toEqual([]);
    expect(db.priorityAggregates()).toEqual([
      { categoryId: null, priority: null, replacedPriority: null, reviewed: false, count: 1 },
    ]);
  });
});

describe('review queue', () => {
  const decision = (status: SaveDecisionInput['status'], departmentId: string | null = null): SaveDecisionInput => ({
    departmentId,
    confidence: 0.5,
    rationale: 'r',
    status,
    quote: null,
    taxonomyVersion: 1,
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

  async function seed(database: TicketDatabase, externalId: string, value: SaveDecisionInput) {
    const ticket = database.insertTicket({ externalId, subject: 's', body: 'b', channel: 'email', email: 'q@example.com' });
    database.saveDecision(ticket.id, value);
    await pause();
    return ticket;
  }

  it('holds only needs_review and failed tickets, oldest first, and an override or a department label removes one', async () => {
    const database = open();
    const old = await seed(database, 'q-1', decision('failed'));
    await seed(database, 'q-2', decision('labeled', 'billing'));
    const middle = await seed(database, 'q-3', decision('needs_review'));
    const newest = await seed(database, 'q-4', decision('needs_review'));
    const queue = database.reviewQueue(200);
    expect(queue.counts).toEqual({ needsReview: 2, failed: 1 });
    expect(queue.tickets.map((t) => t.id)).toEqual([old.id, middle.id, newest.id]);

    // Category and priority corrections do not resolve the department review.
    database.setCategory(middle.id, 'outage');
    database.setPriority(middle.id, 'high');
    expect(database.reviewQueue(200).tickets.map((t) => t.id)).toEqual([old.id, middle.id, newest.id]);

    database.overrideDecision(middle.id, 'billing');
    const after = database.reviewQueue(200);
    expect(after.counts).toEqual({ needsReview: 1, failed: 1 });
    expect(after.tickets.map((t) => t.id)).toEqual([old.id, newest.id]);
  });

  it('counts every unresolved ticket beyond the result cap and breaks createdAt ties by id', () => {
    const database = open();
    for (let i = 0; i < 205; i += 1) {
      const ticket = database.insertTicket({ externalId: `c-${i}`, subject: 's', body: 'b', channel: 'web' });
      database.saveDecision(ticket.id, decision(i % 5 === 0 ? 'failed' : 'needs_review'));
    }
    const queue = database.reviewQueue(200);
    expect(queue.counts).toEqual({ needsReview: 164, failed: 41 });
    expect(queue.tickets).toHaveLength(200);
    const keys = queue.tickets.map((t) => `${t.createdAt}|${t.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('is empty with zero counts', () => {
    expect(open().reviewQueue(200)).toEqual({ counts: { needsReview: 0, failed: 0 }, tickets: [] });
  });
});

describe('decision feedback', () => {
  const labeled: SaveDecisionInput = {
    departmentId: 'billing',
    confidence: 0.9,
    rationale: 'Invoice.',
    status: 'labeled',
    quote: 'Invoice 18',
    taxonomyVersion: 2,
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

  async function seed(database: TicketDatabase, externalId: string, value: SaveDecisionInput) {
    const ticket = database.insertTicket({
      externalId,
      subject: 'Invoice 18',
      body: 'Body text.',
      channel: 'email',
      email: 'private.sender@example.com',
    });
    database.saveDecision(ticket.id, value);
    await pause();
    return ticket;
  }

  it('exports category-only, priority-only, both, confirmations, and null model values, newest first, without email', async () => {
    const database = open();
    const untouched = await seed(database, 'f-0', { ...labeled, categoryId: 'outage', priority: 'low' });
    const categoryOnly = await seed(database, 'f-1', { ...labeled, categoryId: null, priority: 'normal' });
    database.setCategory(categoryOnly.id, 'outage');
    const priorityOnly = await seed(database, 'f-2', { ...labeled, categoryId: 'outage', priority: null });
    database.setPriority(priorityOnly.id, 'urgent');
    const both = await seed(database, 'f-3', { ...labeled, categoryId: 'outage', priority: 'low' });
    database.setCategory(both.id, 'how-to');
    database.setPriority(both.id, 'high');
    const confirmed = await seed(database, 'f-4', { ...labeled, categoryId: 'outage', priority: 'high' });
    database.setCategory(confirmed.id, 'outage');
    database.setPriority(confirmed.id, 'high');
    // Department override alone is not category/priority feedback.
    database.overrideDecision(untouched.id, 'it');

    const items = database.decisionFeedback(500);
    expect(items.map((i) => i.ticketId)).toEqual([confirmed.id, both.id, priorityOnly.id, categoryOnly.id]);
    expect(items[3]).toEqual({
      ticketId: categoryOnly.id,
      externalId: 'f-1',
      subject: 'Invoice 18',
      body: 'Body text.',
      channel: 'email',
      createdAt: categoryOnly.createdAt,
      status: 'labeled',
      departmentId: 'billing',
      categoryReviewed: true,
      modelCategoryId: null,
      categoryId: 'outage',
      priorityReviewed: false,
      modelPriority: null,
      priority: 'normal',
      confidence: 0.9,
      rationale: 'Invoice.',
      quote: 'Invoice 18',
      taxonomyVersion: 2,
    });
    expect(items[2]).toMatchObject({ categoryReviewed: false, priorityReviewed: true, modelPriority: null, priority: 'urgent' });
    expect(items[1]).toMatchObject({ modelCategoryId: 'outage', categoryId: 'how-to', modelPriority: 'low', priority: 'high' });
    expect(items[0]).toMatchObject({ modelCategoryId: 'outage', categoryId: 'outage', modelPriority: 'high', priority: 'high' });
    expect(JSON.stringify(items)).not.toContain('example.com');
    expect(JSON.stringify(items)).not.toContain('"email":');
  });

  it('returns at most the limit', () => {
    const database = open();
    for (let i = 0; i < 12; i += 1) {
      const ticket = database.insertTicket({ externalId: `l-${i}`, subject: 's', body: 'b', channel: 'web' });
      database.saveDecision(ticket.id, labeled);
      database.setPriority(ticket.id, 'low');
    }
    expect(database.decisionFeedback(10)).toHaveLength(10);
  });
});
