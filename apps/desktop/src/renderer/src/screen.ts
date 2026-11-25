import {
  type Category,
  type TicketPriority,
  type DecisionStatus,
  type Department,
  type PriorTicket,
  type SenderSummary,
  type TicketView,
} from '@ticket/shared';

/** What the ticket views show. A review or a failure applies no department. */
export interface TicketFields {
  readonly status: DecisionStatus;
  readonly department: string | null;
  readonly confidence: number;
  readonly rationale: string;
  /** Evidence quoted from the ticket (plain text), or null. */
  readonly quote: string | null;
  readonly taxonomyVersion: number;
}

/** Only `labeled` and `overridden` apply a department, even if a department id is present. */
export function ticketFields(ticket: TicketView): TicketFields {
  const applied = ticket.decision.status === 'labeled' || ticket.decision.status === 'overridden';
  return {
    status: ticket.decision.status,
    department: applied ? ticket.decision.departmentId : null,
    confidence: ticket.decision.confidence,
    rationale: ticket.decision.rationale,
    quote: ticket.decision.quote,
    taxonomyVersion: ticket.decision.taxonomyVersion,
  };
}

export const STATUS_LABELS: Record<DecisionStatus, string> = {
  labeled: 'Labeled',
  needs_review: 'Needs review',
  overridden: 'Overridden',
  failed: 'Failed',
};

export const STATUS_TONES: Record<DecisionStatus, 'ok' | 'warn' | 'danger' | 'accent'> = {
  labeled: 'ok',
  needs_review: 'warn',
  overridden: 'accent',
  failed: 'danger',
};

/** One row of the recent-tickets list: subject, status, department, confidence, channel, created. */
export interface TicketRow {
  readonly id: string;
  readonly subject: string;
  readonly status: DecisionStatus;
  readonly statusLabel: string;
  /** Department name (or id if the row was removed), or null when none is applied. */
  readonly department: string | null;
  readonly confidence: string;
  readonly channel: string;
  readonly created: string;
  /** Category name (or id if the category is gone), or null. */
  readonly category: string | null;
  /** The model's category, only when an admin changed it ("none" when the model gave none). */
  readonly modelCategory: string | null;
  /** The current priority, or null. */
  readonly priority: TicketPriority | null;
  /** The model's priority, only when an admin reviewed the priority and changed it ("none" when it gave none). */
  readonly modelPriority: TicketPriority | 'none' | null;
}

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const PRIORITY_TONES: Record<TicketPriority, 'ok' | 'warn' | 'danger' | 'accent' | undefined> = {
  low: undefined,
  normal: 'ok',
  high: 'warn',
  urgent: 'danger',
};

const categoryName = (id: string, categories: readonly Category[]): string =>
  categories.find((category) => category.id === id)?.name ?? id;

export function ticketRow(
  ticket: TicketView,
  departments: readonly Department[],
  formatDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
  categories: readonly Category[] = [],
): TicketRow {
  const fields = ticketFields(ticket);
  const { decision } = ticket;
  const categoryChanged = decision.categoryReviewed && decision.replacedCategoryId !== decision.categoryId;
  const priorityChanged = decision.priorityReviewed && decision.replacedPriority !== decision.priority;
  const name =
    fields.department === null
      ? null
      : (departments.find((department) => department.id === fields.department)?.name ?? fields.department);
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: fields.status,
    statusLabel: STATUS_LABELS[fields.status],
    department: name,
    confidence: formatConfidence(fields.confidence),
    channel: ticket.channel,
    created: formatDate(ticket.createdAt),
    category: decision.categoryId === null ? null : categoryName(decision.categoryId, categories),
    modelCategory: categoryChanged
      ? decision.replacedCategoryId === null
        ? 'none'
        : categoryName(decision.replacedCategoryId, categories)
      : null,
    priority: decision.priority,
    modelPriority: priorityChanged ? (decision.replacedPriority ?? 'none') : null,
  };
}

export const formatConfidence = (value: number): string => `${Math.round(value * 100)}%`;

/** Electron wraps IPC errors as "Error invoking remote method '…': Error: msg". Keep "msg". */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^Error invoking remote method '[^']+': (?:\w*Error: )?([\s\S]*)$/.exec(text);
  return (match?.[1] ?? text).trim() || 'The request failed.';
}

/** "Unknown sender" when the ticket came without an email. */
export const senderLabel = (email: string | null): string => email ?? 'Unknown sender';

/**
 * One earlier ticket of the same sender as one plain-text line: the same fields the
 * classifier saw (subject, channel, status, department id or none, quote or none, time),
 * plus "was: <id>" when an operator replaced the classifier's department.
 */
export function priorTicketLine(
  prior: PriorTicket,
  formatDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
): string {
  return [
    formatDate(prior.createdAt),
    prior.channel,
    prior.subject,
    STATUS_LABELS[prior.status],
    `department: ${prior.departmentId ?? 'none'}`,
    `quote: ${prior.quote === null ? 'none' : `“${prior.quote}”`}`,
    ...(prior.replacedDepartmentId === null ? [] : [`was: ${prior.replacedDepartmentId}`]),
  ].join(' · ');
}

/**
 * The numeric summary of the earlier tickets as one plain line, e.g.
 * "2 earlier tickets · billing 2 · 1 corrected by an operator". The corrected
 * clause is left out when nothing was overridden.
 */
export function senderSummaryLine(summary: SenderSummary): string {
  return [
    `${summary.tickets} earlier ${summary.tickets === 1 ? 'ticket' : 'tickets'}`,
    ...summary.byDepartment.map((item) => `${item.departmentId} ${item.count}`),
    ...(summary.overridden > 0 ? [`${summary.overridden} corrected by an operator`] : []),
  ].join(' · ');
}
