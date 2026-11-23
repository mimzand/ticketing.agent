import { z } from 'zod';

/** Default applied in the agent host when CLASSIFY_MIN_CONFIDENCE is unset. */
export const CLASSIFY_MIN_CONFIDENCE_DEFAULT = 0.7;

export const DepartmentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'A department id is lowercase letters, digits, and hyphens.');

export const DepartmentSchema = z.strictObject({
  id: DepartmentIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  active: z.boolean(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const CreateDepartmentSchema = z.strictObject({
  id: DepartmentIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
});
export type CreateDepartment = z.infer<typeof CreateDepartmentSchema>;

/**
 * Edit a department. `id` selects the row and cannot change: decisions store it.
 * Name, description, and active are optional; at least one is required.
 */
export const UpdateDepartmentSchema = z
  .strictObject({
    id: DepartmentIdSchema,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.description !== undefined || input.active !== undefined,
    'Change the name, the description, or active.',
  );
export type UpdateDepartment = z.infer<typeof UpdateDepartmentSchema>;

export const DeleteDepartmentSchema = z.strictObject({ id: DepartmentIdSchema });
export type DeleteDepartment = z.infer<typeof DeleteDepartmentSchema>;

export const DeleteDepartmentResultSchema = z.strictObject({
  id: DepartmentIdSchema,
  deleted: z.literal(true),
});
export type DeleteDepartmentResult = z.infer<typeof DeleteDepartmentResultSchema>;

/** The refusal text when a decision still references a department. */
export const DEPARTMENT_IN_USE_MESSAGE =
  'This department cannot be removed: a ticket decision references its id, and decisions are never rewritten. Deactivate it instead.';

export const ClassifyTicketSchema = z.strictObject({
  externalId: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20_000),
  channel: z.string().trim().min(1).max(64),
});
export type ClassifyTicket = z.infer<typeof ClassifyTicketSchema>;

/** Cancel the in-flight submit of this externalId (desktop only). */
export const CancelClassifySchema = z.strictObject({
  externalId: z.string().trim().min(1).max(200),
});
export type CancelClassify = z.infer<typeof CancelClassifySchema>;
export const CancelClassifyResultSchema = z.strictObject({ cancelled: z.boolean() });
export type CancelClassifyResult = z.infer<typeof CancelClassifyResultSchema>;

export const DecisionStatusSchema = z.enum(['labeled', 'needs_review', 'overridden', 'failed']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = z.strictObject({
  departmentId: DepartmentIdSchema.nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
  status: DecisionStatusSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const TicketViewSchema = z.strictObject({
  id: z.uuid(),
  externalId: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().max(20_000),
  channel: z.string().min(1).max(64),
  createdAt: z.iso.datetime(),
  decision: DecisionSchema,
});
export type TicketView = z.infer<typeof TicketViewSchema>;

export const OverrideTicketSchema = z.strictObject({
  id: z.uuid(),
  departmentId: DepartmentIdSchema,
});
export type OverrideTicket = z.infer<typeof OverrideTicketSchema>;

/** What the agent reports about Ollama. The HTTP API copies this into `/health`. */
export const ModelHealthSchema = z.strictObject({
  reachable: z.boolean(),
  model: z.string().min(1).max(128),
});
export type ModelHealth = z.infer<typeof ModelHealthSchema>;

/** Model output before the host applies the confidence and department rules. */
export const ClassifierOutputSchema = z.strictObject({
  departmentId: z.string().trim().min(1).max(64),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(2_000),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;
