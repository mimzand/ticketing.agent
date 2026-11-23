import { describe, expect, it } from 'vitest';
import { senderSummary, type PriorTicket } from './index';

function row(departmentId: string | null, status: PriorTicket['status'] = 'labeled'): PriorTicket {
  return {
    subject: 's',
    channel: 'email',
    status,
    departmentId,
    quote: null,
    replacedDepartmentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('senderSummary', () => {
  it('is empty for no rows', () => {
    expect(senderSummary([])).toEqual({ tickets: 0, byDepartment: [], overridden: 0 });
  });

  it('counts departments, the none bucket, and overrides', () => {
    const summary = senderSummary([
      row('it', 'overridden'),
      row(null, 'needs_review'),
      row('billing'),
      row('it'),
      row('billing', 'overridden'),
    ]);
    expect(summary).toEqual({
      tickets: 5,
      byDepartment: [
        { departmentId: 'billing', count: 2 },
        { departmentId: 'it', count: 2 },
        { departmentId: 'none', count: 1 },
      ],
      overridden: 2,
    });
  });

  it('sorts by count descending, then id ascending', () => {
    const summary = senderSummary([row('zeta'), row('alpha'), row('zeta'), row(null), row('beta')]);
    expect(summary.byDepartment.map((item) => item.departmentId)).toEqual(['zeta', 'alpha', 'beta', 'none']);
  });
});
