import { z } from 'zod';
import {
  DecisionStatusSchema,
  DepartmentIdSchema,
  DepartmentSchema,
  QUOTE_MAX_LENGTH,
} from './ticket.js';
import { CategorySchema } from './category.js';
import { TicketPrioritySchema } from './priority.js';

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

/**
 * One decided ticket whose category or priority an admin reviewed (confirming the
 * model's value counts). `modelCategoryId` / `modelPriority` are what the model had
 * stored before the first admin review (null is a real model value); `categoryId` /
 * `priority` are the final values. No sender field: no email, no sender identity.
 */
export const DecisionFeedbackItemSchema = z.strictObject({
  ticketId: z.uuid(),
  externalId: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().max(20_000),
  channel: z.string().min(1).max(64),
  createdAt: z.iso.datetime(),
  /** The department decision as stored (final), for building an isolated eval case. */
  status: DecisionStatusSchema,
  departmentId: DepartmentIdSchema.nullable(),
  categoryReviewed: z.boolean(),
  modelCategoryId: DepartmentIdSchema.nullable(),
  categoryId: DepartmentIdSchema.nullable(),
  priorityReviewed: z.boolean(),
  modelPriority: TicketPrioritySchema.nullable(),
  priority: TicketPrioritySchema.nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
  quote: z.string().min(1).max(QUOTE_MAX_LENGTH).nullable(),
  taxonomyVersion: z.int().min(0),
});
export type DecisionFeedbackItem = z.infer<typeof DecisionFeedbackItemSchema>;

/** At most this many category/priority feedback rows in one export, newest first. */
export const DECISION_FEEDBACK_LIMIT = 500;

/**
 * Read-only category and priority feedback with the current catalogues. Separate from
 * the department override feedback. Nothing in it is written back anywhere.
 */
export const DecisionFeedbackSchema = z.strictObject({
  taxonomyVersion: z.int().min(0),
  departments: z.array(DepartmentSchema),
  categories: z.array(CategorySchema),
  items: z.array(DecisionFeedbackItemSchema).max(DECISION_FEEDBACK_LIMIT),
});
export type DecisionFeedback = z.infer<typeof DecisionFeedbackSchema>;
