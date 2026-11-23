import { z } from 'zod';
import {
  DecisionStatusSchema,
  DepartmentIdSchema,
  DepartmentSchema,
  QUOTE_MAX_LENGTH,
} from './ticket.js';

/** At most this many override rows in one export, newest first. */
export const OVERRIDE_FEEDBACK_LIMIT = 500;

/**
 * One decided ticket whose first operator override replaced a department the
 * classifier had applied. `replacedDepartmentId` is the classifier's department,
 * `departmentId` the operator's. There is no sender field: the export never
 * carries an email address.
 */
export const OverrideFeedbackItemSchema = z.strictObject({
  ticketId: z.uuid(),
  externalId: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().max(20_000),
  channel: z.string().min(1).max(64),
  createdAt: z.iso.datetime(),
  replacedDepartmentId: DepartmentIdSchema,
  departmentId: DepartmentIdSchema,
  status: DecisionStatusSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
  quote: z.string().min(1).max(QUOTE_MAX_LENGTH).nullable(),
  taxonomyVersion: z.int().min(0),
});
export type OverrideFeedbackItem = z.infer<typeof OverrideFeedbackItemSchema>;

/**
 * Read-only override feedback: the current catalogue (and its taxonomy version) beside
 * the override rows. Data for evaluation and for an operator to review; nothing in it
 * is written back to departments or used to train a model.
 */
export const OverrideFeedbackSchema = z.strictObject({
  taxonomyVersion: z.int().min(0),
  departments: z.array(DepartmentSchema),
  items: z.array(OverrideFeedbackItemSchema).max(OVERRIDE_FEEDBACK_LIMIT),
});
export type OverrideFeedback = z.infer<typeof OverrideFeedbackSchema>;
