import { z } from 'zod';
import { TicketPrioritySchema, type TicketPriority } from './priority.js';
import { DepartmentExamplesSchema, DepartmentIdSchema } from './ticket.js';

/**
 * A problem category: what kind of problem a ticket is, separate from the department
 * that handles it. Defined by an admin. Same id rule as a department; no aliases.
 */
export const CategoryIdSchema = DepartmentIdSchema;

const CategoryNameSchema = z.string().trim().min(1).max(120);
const CategoryDescriptionSchema = z.string().trim().max(2_000);
/** Same limits as department examples. */
export const CategoryExamplesSchema = DepartmentExamplesSchema;

export const CategorySchema = z.strictObject({
  id: CategoryIdSchema,
  name: CategoryNameSchema,
  description: CategoryDescriptionSchema,
  active: z.boolean(),
  /** Prompt guidance only: the host never writes it onto a decision. */
  defaultPriority: TicketPrioritySchema,
  examples: CategoryExamplesSchema,
});
export type Category = z.infer<typeof CategorySchema>;

/** Create: a default priority is required; examples default to none. A new category is active. */
export const CreateCategorySchema = z.strictObject({
  id: CategoryIdSchema,
  name: CategoryNameSchema,
  description: CategoryDescriptionSchema,
  defaultPriority: TicketPrioritySchema,
  examples: CategoryExamplesSchema.default([]),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;
export type CreateCategoryInput = z.input<typeof CreateCategorySchema>;

/** The editable fields. The id is not among them: decisions store it. */
export const CategoryChangesSchema = z.strictObject({
  name: CategoryNameSchema.optional(),
  description: CategoryDescriptionSchema.optional(),
  active: z.boolean().optional(),
  defaultPriority: TicketPrioritySchema.optional(),
  examples: CategoryExamplesSchema.optional(),
});

export const UpdateCategorySchema = CategoryChangesSchema.extend({ id: CategoryIdSchema })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== 'id'),
    'Change the name, the description, active, the default priority, or the examples.',
  );
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

export const DeleteCategorySchema = z.strictObject({ id: CategoryIdSchema });
export type DeleteCategory = z.infer<typeof DeleteCategorySchema>;
export const DeleteCategoryResultSchema = z.strictObject({ id: CategoryIdSchema, deleted: z.literal(true) });
export type DeleteCategoryResult = z.infer<typeof DeleteCategoryResultSchema>;

/** The refusal text when a decision still stores a category id. */
export const CATEGORY_IN_USE_MESSAGE =
  'This category cannot be removed: a ticket decision stores its id, and decisions are never rewritten. Deactivate it instead.';

/** Admin correction of a ticket's category. Only an active category. */
export const SetTicketCategorySchema = z.strictObject({ id: z.uuid(), categoryId: CategoryIdSchema });
export type SetTicketCategory = z.infer<typeof SetTicketCategorySchema>;

/** Admin review of a ticket's priority. */
export const SetTicketPrioritySchema = z.strictObject({ id: z.uuid(), priority: TicketPrioritySchema });
export type SetTicketPriority = z.infer<typeof SetTicketPrioritySchema>;

/** A category needs at least this many admin-reviewed tickets before it gets a trend line. */
export const PRIORITY_TREND_MIN = 5;

/**
 * One group of decisions: how many share this final category, final priority, model
 * priority (`replacedPriority`), and admin-review flag. Counts only, no ticket text.
 */
export const PriorityAggregateSchema = z.strictObject({
  categoryId: CategoryIdSchema.nullable(),
  priority: TicketPrioritySchema.nullable(),
  replacedPriority: TicketPrioritySchema.nullable(),
  reviewed: z.boolean(),
  count: z.int().min(1),
});
export type PriorityAggregate = z.infer<typeof PriorityAggregateSchema>;

export interface PriorityTrend {
  readonly categoryId: string;
  /** Reviewed tickets in this final category. */
  readonly reviewed: number;
  /** The most common final (admin) priority. */
  readonly modal: TicketPriority;
  readonly modalCount: number;
  /** Among the modal rows, the most common model priority ("none" when it gave none). */
  readonly modelSaid: TicketPriority | 'none';
  readonly modelSaidCount: number;
  /** The one-line text the classifier sees. */
  readonly line: string;
}

/** Tie-break order: urgent, then high, normal, low; "none" last. */
const RANK: Record<TicketPriority | 'none', number> = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

function mostCommon<K extends TicketPriority | 'none'>(counts: Map<K, number>): [K, number] {
  let best: [K, number] | undefined;
  for (const entry of counts) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && RANK[entry[0]] < RANK[best[0]])) best = entry;
  }
  if (!best) throw new Error('mostCommon needs at least one entry.');
  return best;
}

/**
 * Pure: trend lines from priority aggregates. Only rows the caller marked reviewed,
 * with a final category and a final priority, count; untouched model rows never do,
 * so the model cannot confirm itself. A category gets a line from PRIORITY_TREND_MIN
 * reviewed tickets. Sorted by category id.
 */
export function priorityTrends(aggregates: readonly PriorityAggregate[]): PriorityTrend[] {
  const byCategory = new Map<string, { priority: TicketPriority; replaced: TicketPriority | 'none'; count: number }[]>();
  for (const row of aggregates) {
    if (!row.reviewed || row.categoryId === null || row.priority === null || row.count < 1) continue;
    const rows = byCategory.get(row.categoryId) ?? [];
    rows.push({ priority: row.priority, replaced: row.replacedPriority ?? 'none', count: row.count });
    byCategory.set(row.categoryId, rows);
  }
  const trends: PriorityTrend[] = [];
  for (const [categoryId, rows] of [...byCategory].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const reviewed = rows.reduce((sum, row) => sum + row.count, 0);
    if (reviewed < PRIORITY_TREND_MIN) continue;
    const finals = new Map<TicketPriority, number>();
    for (const row of rows) finals.set(row.priority, (finals.get(row.priority) ?? 0) + row.count);
    const [modal, modalCount] = mostCommon(finals);
    const said = new Map<TicketPriority | 'none', number>();
    for (const row of rows) if (row.priority === modal) said.set(row.replaced, (said.get(row.replaced) ?? 0) + row.count);
    const [modelSaid, modelSaidCount] = mostCommon(said);
    trends.push({
      categoryId,
      reviewed,
      modal,
      modalCount,
      modelSaid,
      modelSaidCount,
      line:
        `${categoryId}: ${reviewed} reviewed; admin result ${modal} ${modalCount}/${reviewed}. ` +
        `Of those ${modalCount}, the model had said ${modelSaid} on ${modelSaidCount}.`,
    });
  }
  return trends;
}
