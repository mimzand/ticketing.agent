import {
  CategoryExamplesSchema,
  CreateCategorySchema,
  TICKET_PRIORITIES,
  type CreateCategory,
  type TicketPriority,
} from '@ticket/shared';
import { linesToList } from './department-form.js';

/** The priorities in the order the forms list them. */
export const PRIORITY_OPTIONS: readonly TicketPriority[] = TICKET_PRIORITIES;

/** The first problem with the example list, or null. Same limits as department examples. */
export function categoryExamplesProblem(examplesText: string): string | null {
  const examples = CategoryExamplesSchema.safeParse(linesToList(examplesText));
  return examples.success ? null : `Examples: ${examples.error.issues[0]?.message ?? 'invalid.'}`;
}

export interface CategoryAddForm {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Empty until chosen: a default priority is required. */
  readonly defaultPriority: TicketPriority | '';
  readonly examples: string;
}

/** Validates the add form with the shared schema: the category, or the first problem. */
export function parseCategoryForm(form: CategoryAddForm): { ok: true; value: CreateCategory } | { ok: false; error: string } {
  const examplesProblem = categoryExamplesProblem(form.examples);
  if (examplesProblem) return { ok: false, error: examplesProblem };
  if (form.defaultPriority === '') return { ok: false, error: 'Choose a default priority.' };
  const parsed = CreateCategorySchema.safeParse({
    id: form.id,
    name: form.name,
    description: form.description,
    defaultPriority: form.defaultPriority,
    examples: linesToList(form.examples),
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the fields.' };
}
