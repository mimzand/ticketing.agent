import { z } from 'zod';

/** A ticket's priority: exactly one of these four strings. */
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
