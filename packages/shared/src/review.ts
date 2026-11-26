import { z } from 'zod';
import { TicketViewSchema } from './ticket.js';

/** The review queue returns at most this many tickets; the counts cover every unresolved ticket. */
export const REVIEW_QUEUE_LIMIT = 200;

/** Department decision statuses that wait for a human. An override resolves them. */
export const REVIEW_STATUSES = ['needs_review', 'failed'] as const;

/**
 * The human review queue: tickets whose department decision is `needs_review` or
 * `failed`, oldest first (tie-break: ticket id), at most 200, and the full counts.
 */
export const ReviewQueueSchema = z
  .strictObject({
    counts: z.strictObject({
      needsReview: z.int().min(0),
      failed: z.int().min(0),
    }),
    tickets: z.array(TicketViewSchema).max(REVIEW_QUEUE_LIMIT),
  })
  .refine((queue) => queue.tickets.every((ticket) => (REVIEW_STATUSES as readonly string[]).includes(ticket.decision.status)), {
    message: 'Only needs_review and failed tickets belong in the review queue.',
    path: ['tickets'],
  });
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;
