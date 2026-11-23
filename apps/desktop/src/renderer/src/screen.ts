import { type DecisionStatus, type Department, type TicketView } from '@ticket/shared';

/** What the ticket views show. A review or a failure applies no department. */
export interface TicketFields {
  readonly status: DecisionStatus;
  readonly department: string | null;
  readonly confidence: number;
  readonly rationale: string;
}

/** Only `labeled` and `overridden` apply a department, even if a department id is present. */
export function ticketFields(ticket: TicketView): TicketFields {
  const applied = ticket.decision.status === 'labeled' || ticket.decision.status === 'overridden';
  return {
    status: ticket.decision.status,
    department: applied ? ticket.decision.departmentId : null,
    confidence: ticket.decision.confidence,
    rationale: ticket.decision.rationale,
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
}

export function ticketRow(
  ticket: TicketView,
  departments: readonly Department[],
  formatDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
): TicketRow {
  const fields = ticketFields(ticket);
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
  };
}

export const formatConfidence = (value: number): string => `${Math.round(value * 100)}%`;

/** Electron wraps IPC errors as "Error invoking remote method '…': Error: msg". Keep "msg". */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^Error invoking remote method '[^']+': (?:\w*Error: )?([\s\S]*)$/.exec(text);
  return (match?.[1] ?? text).trim() || 'The request failed.';
}
