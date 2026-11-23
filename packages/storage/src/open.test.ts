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
    });
    const stored = database.getById(ticket.id);
    expect(stored?.externalId).toBe('ext-1');
    expect(stored?.decision.status).toBe('labeled');
    expect(database.listRecent()).toHaveLength(1);
  });
});
