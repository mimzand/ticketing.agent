import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

