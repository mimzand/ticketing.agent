import { type Category, type Department, type TicketView } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import { errorMessage, priorTicketLine, senderLabel, senderSummaryLine, ticketFields, ticketRow } from './screen.js';

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  externalId: 'ext-1',
  subject: 'Invoice',
  body: 'Please review.',
  channel: 'email',
  createdAt: '2026-01-01T00:00:00.000Z',
  email: null,
} as const;

const departments: Department[] = [
  { id: 'billing', name: 'Billing', description: '', active: true, aliases: [], examples: [] },
];
const date = () => 'Jan 1';

function ticket(
  status: TicketView['decision']['status'],
  departmentId: string | null,
  quote: string | null = null,
  extra: Partial<TicketView['decision']> = {},
): TicketView {
  return {
    ...base,
    decision: {
      status,
      departmentId,
      confidence: 0.91,
      rationale: 'Invoice wording.',
      quote,
      taxonomyVersion: 3,
      categoryId: null,
      replacedCategoryId: null,
      categoryReviewed: false,
      priority: null,
      replacedPriority: null,
      priorityReviewed: false,
      ...extra,
    },
  };
}

const categories: Category[] = [
  { id: 'outage', name: 'Outage', description: '', active: true, defaultPriority: 'urgent', examples: [] },
  { id: 'how-to', name: 'How-to', description: '', active: false, defaultPriority: 'low', examples: [] },
];

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
      category: null,
      modelCategory: null,
      priority: null,
      modelPriority: null,
    });
  });

  it('shows the category name and the current priority; no model values while nothing was changed', () => {
    const row = ticketRow(ticket('labeled', 'billing', null, { categoryId: 'outage', priority: 'high' }), departments, date, categories);
    expect(row).toMatchObject({ category: 'Outage', modelCategory: null, priority: 'high', modelPriority: null });
  });

  it('shows the model priority only when an admin reviewed it and it differs', () => {
    const confirmed = ticket('labeled', 'billing', null, { priority: 'high', replacedPriority: 'high', priorityReviewed: true });
    expect(ticketRow(confirmed, departments, date, categories).modelPriority).toBeNull();
    const changed = ticket('labeled', 'billing', null, { priority: 'urgent', replacedPriority: 'normal', priorityReviewed: true });
    expect(ticketRow(changed, departments, date, categories)).toMatchObject({ priority: 'urgent', modelPriority: 'normal' });
    const fromNone = ticket('needs_review', null, null, { priority: 'low', replacedPriority: null, priorityReviewed: true });
    expect(ticketRow(fromNone, departments, date, categories).modelPriority).toBe('none');
    // Not reviewed: a replaced value alone is not shown.
    const unreviewed = ticket('labeled', 'billing', null, { priority: 'low', replacedPriority: 'high' });
    expect(ticketRow(unreviewed, departments, date, categories).modelPriority).toBeNull();
  });

  it('shows the model category only when an admin changed it, by name, or none', () => {
    const moved = ticket('labeled', 'billing', null, { categoryId: 'how-to', replacedCategoryId: 'outage', categoryReviewed: true });
    expect(ticketRow(moved, departments, date, categories)).toMatchObject({ category: 'How-to', modelCategory: 'Outage' });
    const set = ticket('labeled', 'billing', null, { categoryId: 'outage', replacedCategoryId: null, categoryReviewed: true });
    expect(ticketRow(set, departments, date, categories).modelCategory).toBe('none');
    const same = ticket('labeled', 'billing', null, { categoryId: 'outage', replacedCategoryId: 'outage', categoryReviewed: true });
    expect(ticketRow(same, departments, date, categories).modelCategory).toBeNull();
    // A removed category shows its id.
    expect(ticketRow(ticket('labeled', 'billing', null, { categoryId: 'gone' }), departments, date, categories).category).toBe('gone');
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

describe('sender display', () => {
  it('shows the address or "Unknown sender"', () => {
    expect(senderLabel('ann@example.com')).toBe('ann@example.com');
    expect(senderLabel(null)).toBe('Unknown sender');
  });

  it('shows a prior ticket as one plain-text line with "none" for a missing department or quote', () => {
    const line = priorTicketLine(
      {
        subject: 'Printer <b>down</b>',
        channel: 'chat',
        status: 'needs_review',
        departmentId: null,
        quote: null,
        replacedDepartmentId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      () => 'Jan 1',
    );
    expect(line).toBe('Jan 1 · chat · Printer <b>down</b> · Needs review · department: none · quote: none');
    expect(
      priorTicketLine(
        {
          subject: 'Invoice',
          channel: 'email',
          status: 'labeled',
          departmentId: 'billing',
          quote: 'Invoice 18',
          replacedDepartmentId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        () => 'Jan 1',
      ),
    ).toBe('Jan 1 · email · Invoice · Labeled · department: billing · quote: “Invoice 18”');
  });

  it('adds "was: <id>" only when the classifier department was replaced', () => {
    expect(
      priorTicketLine(
        {
          subject: 'Laptop',
          channel: 'email',
          status: 'overridden',
          departmentId: 'it',
          quote: null,
          replacedDepartmentId: 'billing',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        () => 'Jan 1',
      ),
    ).toBe('Jan 1 · email · Laptop · Overridden · department: it · quote: none · was: billing');
  });

  it('summarizes earlier tickets in one line', () => {
    expect(
      senderSummaryLine({ tickets: 2, byDepartment: [{ departmentId: 'billing', count: 2 }], overridden: 1 }),
    ).toBe('2 earlier tickets · billing 2 · 1 corrected by an operator');
    expect(
      senderSummaryLine({
        tickets: 3,
        byDepartment: [
          { departmentId: 'it', count: 2 },
          { departmentId: 'none', count: 1 },
        ],
        overridden: 0,
      }),
    ).toBe('3 earlier tickets · it 2 · none 1');
    expect(senderSummaryLine({ tickets: 1, byDepartment: [{ departmentId: 'it', count: 1 }], overridden: 0 })).toBe(
      '1 earlier ticket · it 1',
    );
  });
});
