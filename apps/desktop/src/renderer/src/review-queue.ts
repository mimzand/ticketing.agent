import { REVIEW_STATUSES, type ReviewQueue, type RendererApi, type TicketView } from '@ticket/shared';

/** What the Tickets screen shows above the review queue. */
export interface ReviewQueueSummary {
  readonly total: number;
  readonly needsReview: number;
  readonly failed: number;
  /** "3 unresolved · 2 needs review · 1 failed", or "Nothing to review". */
  readonly label: string;
}

export const EMPTY_REVIEW_QUEUE: ReviewQueue = { counts: { needsReview: 0, failed: 0 }, tickets: [] };

/** A ticket belongs in the queue while its department decision is needs_review or failed. */
export const isUnresolved = (ticket: TicketView): boolean =>
  (REVIEW_STATUSES as readonly string[]).includes(ticket.decision.status);

export function reviewQueueSummary(queue: ReviewQueue | null): ReviewQueueSummary {
  const { needsReview, failed } = (queue ?? EMPTY_REVIEW_QUEUE).counts;
  const total = needsReview + failed;
  return {
    total,
    needsReview,
    failed,
    label: total === 0 ? 'Nothing to review' : `${total} unresolved · ${needsReview} needs review · ${failed} failed`,
  };
}

/** Oldest first, tie-break by ticket id: the same order the agent returns. */
export function sortQueueTickets(tickets: readonly TicketView[]): TicketView[] {
  return [...tickets].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/**
 * Applies a changed ticket to the queue: a resolved ticket (a department override)
 * leaves it and its count drops; a category or priority change only replaces the row.
 */
export function applyQueueUpdate(queue: ReviewQueue, updated: TicketView): ReviewQueue {
  const index = queue.tickets.findIndex((ticket) => ticket.id === updated.id);
  if (index < 0) return queue;
  const previous = queue.tickets[index];
  if (isUnresolved(updated)) {
    return { ...queue, tickets: queue.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)) };
  }
  const counts = { ...queue.counts };
  if (previous?.decision.status === 'needs_review') counts.needsReview = Math.max(0, counts.needsReview - 1);
  if (previous?.decision.status === 'failed') counts.failed = Math.max(0, counts.failed - 1);
  return { counts, tickets: queue.tickets.filter((ticket) => ticket.id !== updated.id) };
}

export async function loadReviewQueue(api: Pick<RendererApi, 'reviewQueue'>): Promise<ReviewQueue> {
  const queue = await api.reviewQueue();
  return { counts: queue.counts, tickets: sortQueueTickets(queue.tickets) };
}

/**
 * After a successful department override: drop the resolved row at once, then reload
 * the queue from the agent. If the reload fails, the local result stands.
 */
export async function refreshAfterOverride(
  queue: ReviewQueue,
  updated: TicketView,
  api: Pick<RendererApi, 'reviewQueue'>,
): Promise<ReviewQueue> {
  const local = applyQueueUpdate(queue, updated);
  try {
    return await loadReviewQueue(api);
  } catch {
    return local;
  }
}
