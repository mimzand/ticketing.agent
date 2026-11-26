import {
  DecisionFeedbackSchema,
  EXAMPLE_MAX_LENGTH,
  TicketPrioritySchema,
  type DecisionFeedback,
  type DecisionFeedbackItem,
} from '@ticket/shared';
import { z } from 'zod';
import { exampleSnippet, type SkippedOverride } from './feedback.js';
import { parseSuiteFile, SUITE_FORMAT_VERSION, type EvalCase, type ModelReply, type SuiteFile } from './suite.js';

/** The catalogue name used in a suite generated from a decision feedback export. */
export const FEEDBACK_CATALOGUE = 'export';

export type SkippedFeedback = SkippedOverride;

/**
 * Turns a category/priority feedback export into a suite file of `source: "feedback"`
 * cases. Each case expects the admin's final category only when the category was
 * reviewed, and the final priority only when the priority was reviewed.
 *
 * `reply` is a placeholder with a valid active department (the stored one when it is
 * active, else the first active one) above the threshold, so category and priority are
 * judged apart from department routing. `wrongReply` carries the model's original values
 * for the reviewed fields, only when at least one of them differs from the admin's; a
 * confirmation stays a positive case without one. No email is read or written.
 */
export function decisionFeedbackSuite(
  raw: DecisionFeedback,
  options: { readonly suite?: string; readonly threshold?: number } = {},
): { readonly file: SuiteFile | null; readonly skipped: readonly SkippedFeedback[] } {
  const feedback = DecisionFeedbackSchema.parse(raw);
  const threshold = options.threshold ?? 0.7;
  const activeDepartments = feedback.departments.filter((d) => d.active);
  const activeCategories = new Set(feedback.categories.filter((c) => c.active).map((c) => c.id));
  const skipped: SkippedFeedback[] = [];
  const cases: EvalCase[] = [];

  for (const item of feedback.items) {
    const skip = (reason: string) => skipped.push({ ticketId: item.ticketId, reason });
    if (!item.categoryReviewed && !item.priorityReviewed) {
      skip('neither the category nor the priority was reviewed');
      continue;
    }
    const department =
      activeDepartments.find((d) => d.id === item.departmentId) ?? activeDepartments[0] ?? null;
    if (!department) {
      skip('there is no active department for the placeholder reply');
      continue;
    }
    if (item.categoryReviewed && item.categoryId !== null && !activeCategories.has(item.categoryId)) {
      skip('the reviewed category is not active');
      continue;
    }
    if (item.priorityReviewed && item.priority === null) {
      skip('the reviewed priority is missing');
      continue;
    }
    // Fields that were not reviewed are not judged; the placeholder still answers them.
    const categoryId = item.categoryId !== null && activeCategories.has(item.categoryId) ? item.categoryId : null;
    const placeholder = {
      departmentId: department.id,
      confidence: Math.max(0.95, threshold),
      rationale: 'Placeholder for the admin-reviewed values; replace with a recorded reply.',
      quote: null,
      categoryId,
      priority: item.priority,
    };
    const categoryDiffers = item.categoryReviewed && item.modelCategoryId !== item.categoryId;
    const priorityDiffers = item.priorityReviewed && item.modelPriority !== item.priority;
    const wrongReply: ModelReply | undefined =
      categoryDiffers || priorityDiffers
        ? {
            kind: 'scripted',
            output: {
              ...placeholder,
              ...(item.categoryReviewed && { categoryId: item.modelCategoryId }),
              ...(item.priorityReviewed && { priority: item.modelPriority }),
            },
          }
        : undefined;
    cases.push({
      id: `feedback-${item.ticketId}`,
      source: 'feedback',
      description: describe(item),
      catalogue: FEEDBACK_CATALOGUE,
      history: [],
      ticket: { externalId: item.externalId, subject: item.subject, body: item.body, channel: item.channel },
      reply: { kind: 'scripted', output: placeholder },
      ...(wrongReply && { wrongReply }),
      expect: {
        status: 'labeled',
        departmentId: department.id,
        confidence: 'above',
        ...(item.categoryReviewed && { categoryId: item.categoryId }),
        ...(item.priorityReviewed && { priority: TicketPrioritySchema.parse(item.priority) }),
      },
      feedbackOrigin: {
        ticketId: item.ticketId,
        categoryReviewed: item.categoryReviewed,
        modelCategoryId: item.modelCategoryId,
        priorityReviewed: item.priorityReviewed,
        modelPriority: item.modelPriority,
        taxonomyVersion: item.taxonomyVersion,
      },
    });
  }
  if (cases.length === 0) return { file: null, skipped };
  const file = parseSuiteFile('decision feedback export', {
    formatVersion: SUITE_FORMAT_VERSION,
    suite: options.suite ?? 'decision-feedback',
    threshold,
    catalogues: { [FEEDBACK_CATALOGUE]: feedback.departments },
    categories: { [FEEDBACK_CATALOGUE]: feedback.categories },
    cases,
  });
  return { file, skipped };
}

function describe(item: DecisionFeedbackItem): string {
  const parts: string[] = [];
  if (item.categoryReviewed) {
    parts.push(
      item.modelCategoryId === item.categoryId
        ? `An admin confirmed category ${item.categoryId ?? 'none'}.`
        : `An admin changed category ${item.modelCategoryId ?? 'none'} to ${item.categoryId ?? 'none'}.`,
    );
  }
  if (item.priorityReviewed) {
    parts.push(
      item.modelPriority === item.priority
        ? `An admin confirmed priority ${item.priority ?? 'none'}.`
        : `An admin changed priority ${item.modelPriority ?? 'none'} to ${item.priority ?? 'none'}.`,
    );
  }
  return parts.join(' ');
}

export const CategoryFewShotCandidateSchema = z.strictObject({
  /** The category whose `examples` this could be added to, by an operator. */
  categoryId: z.string().min(1).max(64),
  example: z.string().min(1).max(EXAMPLE_MAX_LENGTH),
  /** What the model had stored before the admin review (null when it gave none). */
  modelCategoryId: z.string().min(1).max(64).nullable(),
  ticketId: z.uuid(),
  taxonomyVersion: z.int().min(0),
});
export type CategoryFewShotCandidate = z.infer<typeof CategoryFewShotCandidateSchema>;

export const CategoryFewShotCandidatesSchema = z.strictObject({
  formatVersion: z.literal(1),
  /** Candidates only: nothing is applied until an operator copies one into a category. */
  approval: z.literal('operator'),
  candidates: z.array(CategoryFewShotCandidateSchema),
});
export type CategoryFewShotCandidates = z.infer<typeof CategoryFewShotCandidatesSchema>;

/**
 * Operator-approved category few-shot candidates: one short, privacy-reduced example per
 * admin-reviewed ticket with an active final category, skipping examples the category
 * already has. Priority gets none (it learns from the aggregate admin trends). Read only.
 */
export function categoryFewShotCandidates(raw: DecisionFeedback): {
  readonly candidates: CategoryFewShotCandidates;
  readonly skipped: readonly SkippedFeedback[];
} {
  const feedback = DecisionFeedbackSchema.parse(raw);
  const skipped: SkippedFeedback[] = [];
  const seen = new Set<string>();
  const candidates: CategoryFewShotCandidate[] = [];
  for (const item of feedback.items) {
    const skip = (reason: string) => skipped.push({ ticketId: item.ticketId, reason });
    if (!item.categoryReviewed) {
      skip('the category was not reviewed');
      continue;
    }
    if (item.categoryId === null) {
      skip('the reviewed category is empty');
      continue;
    }
    const category = feedback.categories.find((c) => c.id === item.categoryId);
    if (!category) {
      skip('the category no longer exists');
      continue;
    }
    if (!category.active) {
      skip('the category is not active');
      continue;
    }
    const example = exampleSnippet(item.subject, item.body);
    const key = `${category.id}\n${example.toLowerCase()}`;
    if (seen.has(key) || category.examples.some((e) => e.toLowerCase() === example.toLowerCase())) {
      skip('the category already has this example');
      continue;
    }
    seen.add(key);
    candidates.push({
      categoryId: category.id,
      example,
      modelCategoryId: item.modelCategoryId,
      ticketId: item.ticketId,
      taxonomyVersion: item.taxonomyVersion,
    });
  }
  return {
    candidates: CategoryFewShotCandidatesSchema.parse({ formatVersion: 1, approval: 'operator', candidates }),
    skipped,
  };
}
