import { type Department, type TicketView } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import { errorMessage, ticketFields, ticketRow } from './screen.js';

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  externalId: 'ext-1',
  subject: 'Invoice',
  body: 'Please review.',
  channel: 'email',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

const departments: Department[] = [
  { id: 'billing', name: 'Billing', description: '', active: true, aliases: [], examples: [] },
];
const date = () => 'Jan 1';

function ticket(
  status: TicketView['decision']['status'],
  departmentId: string | null,
  quote: string | null = null,
): TicketView {
  return {
    ...base,
    decision: { status, departmentId, confidence: 0.91, rationale: 'Invoice wording.', quote, taxonomyVersion: 3 },
  };
}

describe('ticketFields', () => {
  it('shows the department for a labeled result', () => {
    expect(ticketFields(ticket('labeled', 'billing'))).toEqual({
      status: 'labeled',
      department: 'billing',
      confidence: 0.91,
      rationale: 'Invoice wording.',
      quote: null,
      taxonomyVersion: 3,
    });
  });

  it('shows a stored quote as plain text, for labeled and needs_review alike', () => {
    expect(ticketFields(ticket('labeled', 'billing', 'Please review.')).quote).toBe('Please review.');
    const review = ticketFields(ticket('needs_review', 'billing', 'Please review.'));
    expect(review).toMatchObject({ department: null, quote: 'Please review.' });
  });

  it('applies no department for needs_review or failed, even with a department id present', () => {
    expect(ticketFields(ticket('needs_review', null)).department).toBeNull();
    expect(ticketFields(ticket('needs_review', 'billing')).department).toBeNull();
    expect(ticketFields(ticket('failed', 'billing')).department).toBeNull();
  });
});

describe('ticketRow', () => {
  it('a labeled ticket shows its department name', () => {
    expect(ticketRow(ticket('labeled', 'billing'), departments, date)).toEqual({
      id: base.id,
      subject: 'Invoice',
      status: 'labeled',
      statusLabel: 'Labeled',
      department: 'Billing',
      confidence: '91%',
      channel: 'email',
      created: 'Jan 1',
    });
  });

  it('a needs_review ticket shows no department', () => {
    const row = ticketRow(ticket('needs_review', 'billing'), departments, date);
    expect(row.department).toBeNull();
    expect(row.statusLabel).toBe('Needs review');
  });

  it('an overridden ticket shows its department, even after the department row is gone', () => {
    expect(ticketRow(ticket('overridden', 'legacy'), departments, date).department).toBe('legacy');
  });
});

describe('errorMessage', () => {
  it('strips the Electron IPC prefix', () => {
    const error = new Error(
      "Error invoking remote method 'departments:delete': Error: This department cannot be removed.",
    );
    expect(errorMessage(error)).toBe('This department cannot be removed.');
  });
});
