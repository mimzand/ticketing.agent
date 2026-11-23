import {
  EXAMPLE_MAX_LENGTH,
  OverrideFeedbackSchema,
  type OverrideFeedback,
  type OverrideFeedbackItem,
} from '@ticket/shared';
import { z } from 'zod';
import { parseSuiteFile, SUITE_FORMAT_VERSION, type EvalCase, type SuiteFile } from './suite.js';

/** The catalogue name used in a suite generated from an export. */
export const EXPORT_CATALOGUE = 'export';

export interface SkippedOverride {
  readonly ticketId: string;
  readonly reason: string;
}

/** Why an override cannot become a case or a candidate under the exported catalogue. */
function skipReason(feedback: OverrideFeedback, item: OverrideFeedbackItem): string | null {
  if (item.departmentId === item.replacedDepartmentId) return 'the operator kept the classifier department';
  const department = feedback.departments.find((d) => d.id === item.departmentId);
  if (!department) return 'the operator department no longer exists';
  if (!department.active) return 'the operator department is not active';
  return null;
}

/**
 * Turns an override export into a suite file of `source: "override"` cases.
 *
 * Each case expects the operator department. `reply` is a placeholder that answers the
 * operator department, so the case passes in scripted mode and checks that the current
 * catalogue still accepts that label; replace it with a recorded reply to measure a
 * model. `wrongReply` is the classifier's stored answer, which must not pass.
 * No email is read or written.
 */
export function overrideSuiteFromFeedback(
  raw: OverrideFeedback,
  options: { readonly suite?: string; readonly threshold?: number } = {},
): { readonly file: SuiteFile; readonly skipped: readonly SkippedOverride[] } {
  const feedback = OverrideFeedbackSchema.parse(raw);
  const threshold = options.threshold ?? 0.7;
  const skipped: SkippedOverride[] = [];
  const cases: EvalCase[] = [];
  for (const item of feedback.items) {
    const reason = skipReason(feedback, item);
    if (reason) {
      skipped.push({ ticketId: item.ticketId, reason });
      continue;
    }
    cases.push({
      id: `override-${item.ticketId}`,
      source: 'override',
      description: `An operator changed ${item.replacedDepartmentId} to ${item.departmentId}.`,
      catalogue: EXPORT_CATALOGUE,
      history: [],
      ticket: { externalId: item.externalId, subject: item.subject, body: item.body, channel: item.channel },
      reply: {
        kind: 'scripted',
        output: {
          departmentId: item.departmentId,
          confidence: Math.max(0.95, threshold),
          rationale: 'Placeholder for the operator department; replace with a recorded reply.',
          quote: null,
        },
      },
      wrongReply: {
        kind: 'scripted',
        output: {
          departmentId: item.replacedDepartmentId,
          confidence: item.confidence,
          rationale: item.rationale.trim() || 'Classifier answer.',
          quote: item.quote,
        },
      },
      expect: { status: 'labeled', departmentId: item.departmentId, confidence: 'above' },
      origin: {
        ticketId: item.ticketId,
        replacedDepartmentId: item.replacedDepartmentId,
        taxonomyVersion: item.taxonomyVersion,
      },
    });
  }
  const file = parseSuiteFile('override export', {
    formatVersion: SUITE_FORMAT_VERSION,
    suite: options.suite ?? 'overrides',
    threshold,
    catalogues: { [EXPORT_CATALOGUE]: feedback.departments },
    cases,
  });
  return { file, skipped };
}

export const FewShotCandidateSchema = z.strictObject({
  /** The department whose `examples` this could be added to, by an operator. */
  departmentId: z.string().min(1).max(64),
  example: z.string().min(1).max(EXAMPLE_MAX_LENGTH),
  /** What the classifier had applied instead. */
  replacedDepartmentId: z.string().min(1).max(64),
  ticketId: z.uuid(),
  taxonomyVersion: z.int().min(0),
});
export type FewShotCandidate = z.infer<typeof FewShotCandidateSchema>;

export const FewShotCandidatesSchema = z.strictObject({
  formatVersion: z.literal(1),
  /** Candidates only: nothing here is applied until an operator copies it into a department. */
  approval: z.literal('operator'),
  taxonomyVersion: z.int().min(0),
  candidates: z.array(FewShotCandidateSchema),
});
export type FewShotCandidates = z.infer<typeof FewShotCandidatesSchema>;

const EMAIL_LIKE = /[^\s@<>()[\]",;:]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A short example from a ticket: "subject — body", whitespace collapsed, anything that
 * looks like an email address replaced by "[email]", cut to the department example limit.
 */
export function exampleSnippet(subject: string, body: string): string {
  const text = [subject, body]
    .map((part) => part.replace(EMAIL_LIKE, '[email]').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' — ');
  return text.length <= EXAMPLE_MAX_LENGTH ? text : `${text.slice(0, EXAMPLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Operator-approved few-shot candidates: one short example per override, for the
 * operator department, skipping ones the department already has. Read only: the
 * catalogue is never changed here.
 */
export function fewShotCandidates(raw: OverrideFeedback): {
  readonly candidates: FewShotCandidates;
  readonly skipped: readonly SkippedOverride[];
} {
  const feedback = OverrideFeedbackSchema.parse(raw);
  const skipped: SkippedOverride[] = [];
  const seen = new Set<string>();
  const candidates: FewShotCandidate[] = [];
  for (const item of feedback.items) {
    const reason = skipReason(feedback, item);
    if (reason) {
      skipped.push({ ticketId: item.ticketId, reason });
      continue;
    }
    const example = exampleSnippet(item.subject, item.body);
    const existing = feedback.departments.find((d) => d.id === item.departmentId)?.examples ?? [];
    const key = `${item.departmentId}\n${example.toLowerCase()}`;
    if (seen.has(key) || existing.some((e) => e.toLowerCase() === example.toLowerCase())) {
      skipped.push({ ticketId: item.ticketId, reason: 'the department already has this example' });
      continue;
    }
    seen.add(key);
    candidates.push({
      departmentId: item.departmentId,
      example,
      replacedDepartmentId: item.replacedDepartmentId,
      ticketId: item.ticketId,
      taxonomyVersion: item.taxonomyVersion,
    });
  }
  return {
    candidates: FewShotCandidatesSchema.parse({
      formatVersion: 1,
      approval: 'operator',
      taxonomyVersion: feedback.taxonomyVersion,
      candidates,
    }),
    skipped,
  };
}
