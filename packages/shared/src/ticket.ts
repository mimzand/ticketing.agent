import { z } from 'zod';

/** Default applied in the agent host when CLASSIFY_MIN_CONFIDENCE is unset. */
export const CLASSIFY_MIN_CONFIDENCE_DEFAULT = 0.7;

export const DepartmentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'A department id is lowercase letters, digits, and hyphens.');

export const MAX_ALIASES = 20;
export const MAX_EXAMPLES = 20;
export const ALIAS_MAX_LENGTH = 64;
export const EXAMPLE_MAX_LENGTH = 300;

/** How aliases are compared: trimmed, case-insensitive. Two departments may not share one. */
export const aliasKey = (alias: string): string => alias.trim().toLowerCase();

/** A short label for a department (1–64 characters). An alias is not an id. */
export const DepartmentAliasSchema = z
  .string()
  .trim()
  .min(1, 'An alias cannot be empty.')
  .max(ALIAS_MAX_LENGTH, `An alias is at most ${ALIAS_MAX_LENGTH} characters.`);

/** A short sample of ticket text that belongs to the department (1–300 characters). */
export const DepartmentExampleSchema = z
  .string()
  .trim()
  .min(1, 'An example cannot be empty.')
  .max(EXAMPLE_MAX_LENGTH, `An example is at most ${EXAMPLE_MAX_LENGTH} characters.`);

const noDuplicates = (key: (value: string) => string, what: string) => (values: readonly string[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) {
      ctx.addIssue({ code: 'custom', message: `The same ${what} is listed twice.` });
      return;
    }
    seen.add(k);
  }
};

export const DepartmentAliasesSchema = z
  .array(DepartmentAliasSchema)
  .max(MAX_ALIASES, `At most ${MAX_ALIASES} aliases.`)
  .superRefine(noDuplicates(aliasKey, 'alias'));
export const DepartmentExamplesSchema = z
  .array(DepartmentExampleSchema)
  .max(MAX_EXAMPLES, `At most ${MAX_EXAMPLES} examples.`)
  .superRefine(noDuplicates((value) => value.trim(), 'example'));

const DepartmentNameSchema = z.string().trim().min(1).max(120);
const DepartmentDescriptionSchema = z.string().trim().max(2_000);

export const DepartmentSchema = z.strictObject({
  id: DepartmentIdSchema,
  name: DepartmentNameSchema,
  description: DepartmentDescriptionSchema,
  active: z.boolean(),
  aliases: DepartmentAliasesSchema,
  examples: DepartmentExamplesSchema,
});
export type Department = z.infer<typeof DepartmentSchema>;

/** Create: aliases and examples are optional and default to none. A new department is active. */
export const CreateDepartmentSchema = z.strictObject({
  id: DepartmentIdSchema,
  name: DepartmentNameSchema,
  description: DepartmentDescriptionSchema,
  aliases: DepartmentAliasesSchema.default([]),
  examples: DepartmentExamplesSchema.default([]),
});
export type CreateDepartment = z.infer<typeof CreateDepartmentSchema>;
export type CreateDepartmentInput = z.input<typeof CreateDepartmentSchema>;

/** The editable fields. Lists replace the stored lists. The id is not among them. */
export const DepartmentChangesSchema = z.strictObject({
  name: DepartmentNameSchema.optional(),
  description: DepartmentDescriptionSchema.optional(),
  active: z.boolean().optional(),
  aliases: DepartmentAliasesSchema.optional(),
  examples: DepartmentExamplesSchema.optional(),
});

/**
 * Edit a department. `id` selects the row and cannot change: decisions store it.
 * Name, description, active, aliases, and examples are optional; at least one is required.
 */
export const UpdateDepartmentSchema = DepartmentChangesSchema.extend({ id: DepartmentIdSchema })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== 'id'),
    'Change the name, the description, active, the aliases, or the examples.',
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

export const QUOTE_MAX_LENGTH = 240;

export const DecisionSchema = z.strictObject({
  departmentId: DepartmentIdSchema.nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(2_000),
  status: DecisionStatusSchema,
  /** Evidence: an exact substring of the ticket's subject or body, or null. */
  quote: z.string().min(1).max(QUOTE_MAX_LENGTH).nullable(),
  /** The taxonomy version the classify used. 0 when no department existed (or before versions). */
  taxonomyVersion: z.int().min(0),
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
  /** The model's evidence. The host keeps it only if it is an exact substring of the ticket. */
  quote: z.string().max(20_000).nullable().optional(),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

/**
 * The quote the host stores: the model's quote when it is an exact substring of the
 * ticket's subject or body and at most 240 characters; otherwise null. Never repaired.
 */
export function acceptQuote(
  quote: string | null | undefined,
  ticket: { readonly subject: string; readonly body: string },
): string | null {
  if (typeof quote !== 'string' || quote.length === 0 || quote.length > QUOTE_MAX_LENGTH) return null;
  return ticket.subject.includes(quote) || ticket.body.includes(quote) ? quote : null;
}

/** One saved state of the department catalogue. */
export const TaxonomyVersionSummarySchema = z.strictObject({
  version: z.int().positive(),
  createdAt: z.iso.datetime(),
  departmentCount: z.int().min(0),
});
export type TaxonomyVersionSummary = z.infer<typeof TaxonomyVersionSummarySchema>;

/** The current version (0 before any department) and the history, newest first. Read only. */
export const TaxonomyStateSchema = z.strictObject({
  current: z.int().min(0),
  history: z.array(TaxonomyVersionSummarySchema),
});
export type TaxonomyState = z.infer<typeof TaxonomyStateSchema>;
