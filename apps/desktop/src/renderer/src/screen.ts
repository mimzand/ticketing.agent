import { type DecisionStatus, type TicketView } from '@ticket/shared';

/** What the ticket card shows. A review or a failure applies no department. */
export interface TicketFields {
  readonly status: DecisionStatus;
  readonly department: string | null;
  readonly confidence: number;
  readonly rationale: string;
}

export function ticketFields(ticket: TicketView): TicketFields {
  const applied = ticket.decision.status === 'labeled' || ticket.decision.status === 'overridden';
  return {
    status: ticket.decision.status,
    department: applied ? ticket.decision.departmentId : null,
    confidence: ticket.decision.confidence,
    rationale: ticket.decision.rationale,
  };
}
