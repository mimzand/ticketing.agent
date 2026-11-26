import { type ReviewQueue, type TicketView } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import {
  applyQueueUpdate,
  EMPTY_REVIEW_QUEUE,
  loadReviewQueue,
  refreshAfterOverride,
  reviewQueueSummary,
  sortQueueTickets,
} from './review-queue.js';

function ticket(id: string, createdAt: string, status: TicketView['decision']['status'], extra: Partial<TicketView['decision']> = {}): TicketView {
  return {
    id,
    externalId: `ext-${id}`,
    subject: 'Subject',
    body: '',
    channel: 'email',
    createdAt,
    email: null,
    decision: {
      departmentId: status === 'overridden' ? 'billing' : null,
      confidence: 0.4,
      rationale: 'r',
      status,
      quote: null,
      taxonomyVersion: 1,
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

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const a = ticket(ID(1), '2026-01-01T00:00:00.000Z', 'failed');
const b = ticket(ID(2), '2026-01-02T00:00:00.000Z', 'needs_review');
const c = ticket(ID(3), '2026-01-02T00:00:00.000Z', 'needs_review');
const queue: ReviewQueue = { counts: { needsReview: 7, failed: 1 }, tickets: [a, b, c] };

describe('review queue', () => {
  it('shows the total and the separate counts, which cover rows beyond the list', () => {
    expect(reviewQueueSummary(queue)).toEqual({
      total: 8,
      needsReview: 7,
      failed: 1,
      label: '8 unresolved · 7 needs review · 1 failed',
    });
  });

  it('shows an empty queue', () => {
    expect(reviewQueueSummary(EMPTY_REVIEW_QUEUE)).toEqual({ total: 0, needsReview: 0, failed: 0, label: 'Nothing to review' });
    expect(reviewQueueSummary(null).label).toBe('Nothing to review');
  });

  it('keeps the oldest first with the id as tie-break', async () => {
    expect(sortQueueTickets([c, b, a]).map((t) => t.id)).toEqual([ID(1), ID(2), ID(3)]);
    const loaded = await loadReviewQueue({ reviewQueue: async () => ({ ...queue, tickets: [c, a, b] }) });
    expect(loaded.tickets.map((t) => t.id)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it('a category or priority change keeps the row; a department override removes it', () => {
    const recategorized = ticket(ID(2), b.createdAt, 'needs_review', { categoryId: 'outage', categoryReviewed: true, priority: 'high', priorityReviewed: true });
    const kept = applyQueueUpdate(queue, recategorized);
    expect(kept.tickets.map((t) => t.id)).toEqual([ID(1), ID(2), ID(3)]);
    expect(kept.tickets[1]?.decision.priority).toBe('high');
    expect(kept.counts).toEqual(queue.counts);

    const overridden = applyQueueUpdate(queue, ticket(ID(1), a.createdAt, 'overridden'));
    expect(overridden.tickets.map((t) => t.id)).toEqual([ID(2), ID(3)]);
    expect(overridden.counts).toEqual({ needsReview: 7, failed: 0 });
  });

  it('refreshes from the agent after an override, and keeps the local removal if the refresh fails', async () => {
    const resolved = ticket(ID(2), b.createdAt, 'overridden');
    let calls = 0;
    const fresh = await refreshAfterOverride(queue, resolved, {
      reviewQueue: async () => {
        calls += 1;
        return { counts: { needsReview: 6, failed: 1 }, tickets: [a, c] };
      },
    });
    expect(calls).toBe(1);
    expect(fresh).toEqual({ counts: { needsReview: 6, failed: 1 }, tickets: [a, c] });

    const offline = await refreshAfterOverride(queue, resolved, {
      reviewQueue: () => Promise.reject(new Error('agent down')),
    });
    expect(offline.tickets.map((t) => t.id)).toEqual([ID(1), ID(3)]);
    expect(offline.counts).toEqual({ needsReview: 6, failed: 1 });

    const emptied = applyQueueUpdate({ counts: { needsReview: 0, failed: 1 }, tickets: [a] }, ticket(ID(1), a.createdAt, 'overridden'));
    expect(reviewQueueSummary(emptied).label).toBe('Nothing to review');
    expect(emptied.tickets).toEqual([]);
  });
});
