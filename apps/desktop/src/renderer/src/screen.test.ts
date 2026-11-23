import { type TicketView } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import { ticketFields } from './screen.js';

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  externalId: 'ext-1',
  subject: 'Invoice',
  body: 'Please review.',
  channel: 'email',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

function ticket(status: TicketView['decision']['status'], departmentId: string | null): TicketView {
  return {
    ...base,
    decision: { status, departmentId, confidence: 0.91, rationale: 'Invoice wording.' },
  };
}

describe('ticketFields', () => {
  it('shows the department for a labeled result', () => {
    expect(ticketFields(ticket('labeled', 'billing'))).toEqual({
      status: 'labeled',
      department: 'billing',
      confidence: 0.91,
      rationale: 'Invoice wording.',
    });
  });

  it('applies no department for a needs_review result', () => {
    expect(ticketFields(ticket('needs_review', null)).department).toBeNull();
    expect(ticketFields(ticket('needs_review', 'billing')).department).toBeNull();
  });
});
