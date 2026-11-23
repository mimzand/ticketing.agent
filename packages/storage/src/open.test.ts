import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type Decision } from '@ticket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openTicketDatabase, type TicketDatabase } from './open.js';

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

describe('replaced department', () => {
  const decision: Decision = {
    departmentId: 'billing',
    confidence: 0.9,
    rationale: 'Invoice.',
    status: 'labeled',
    quote: 'Invoice 18',
    taxonomyVersion: 1,
  };

  function decided(database: TicketDatabase, externalId: string, value: Decision = decision) {
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
    expect(database.getById(ticket.id)?.decision).toEqual({ ...decision, departmentId: 'it', status: 'overridden' });

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
