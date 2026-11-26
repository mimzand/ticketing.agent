import { openTicketDatabase, type TicketDatabase } from '@ticket/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelCatalogueSchema } from './catalogue.js';
import { loadPanelCatalogue } from './catalogue-load.js';

let db: TicketDatabase | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function open(): TicketDatabase {
  dir = mkdtempSync(join(tmpdir(), 'ticket-adk-catalogue-'));
  db = openTicketDatabase(join(dir, 'tickets.db'));
  return db;
}

describe('loadPanelCatalogue', () => {
  it('keeps active departments and categories and leaves the token out', () => {
    const database = open();
    database.insertDepartment({
      id: 'billing',
      name: 'Billing',
      description: 'Invoices',
      aliases: ['Accounts payable'],
      examples: ['My invoice is wrong'],
    });
    database.insertDepartment({ id: 'old', name: 'Old', description: 'Retired' });
    database.updateDepartment({ id: 'old', active: false });
    database.insertCategory({
      id: 'outage',
      name: 'Outage',
      description: 'A service is down',
      defaultPriority: 'urgent',
      examples: ['The site is down'],
    });
    database.insertCategory({
      id: 'retired',
      name: 'Retired',
      description: 'No longer used',
      defaultPriority: 'low',
    });
    database.updateCategory({ id: 'retired', active: false });

    const catalogue = loadPanelCatalogue(database, {
      OLLAMA_MODEL: 'panel-model',
      OLLAMA_TOKEN: 'secret-token',
    });
    expect(PanelCatalogueSchema.parse(catalogue)).toEqual(catalogue);
    expect(catalogue.departments.map((department) => department.id)).toEqual(['billing']);
    expect(catalogue.departments[0]).toMatchObject({
      aliases: ['Accounts payable'],
      examples: ['My invoice is wrong'],
    });
    expect(catalogue.categories.categories.map((category) => category.id)).toEqual(['outage']);
    expect(catalogue.categories.categories[0]?.defaultPriority).toBe('urgent');
    expect(catalogue.ollama.model).toBe('panel-model');
    expect(JSON.stringify(catalogue)).not.toContain('secret-token');
    expect(catalogue.categories.priorityTrends).toEqual([]);
  });
});
