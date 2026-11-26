import { createAgentHost } from '@ticket/agent-host';
import { CLASSIFY_MIN_CONFIDENCE_DEFAULT } from '@ticket/shared';
import { openTicketDatabase } from '@ticket/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { judge, type Outcome } from './run.js';
import {
  CatalogueCategorySchema,
  CatalogueDepartmentSchema,
  EvalCaseSchema,
  ExpectationSchema,
  parseSuiteFile,
  SUITE_FORMAT_VERSION,
  type SuiteFile,
} from './suite.js';

/**
 * A synthetic (or privacy-reviewed) ticket to record one live model answer for. The
 * expectation is mandatory and written by a human: the live answer never replaces it.
 * Strict: a ticket `email` (sender identity) is refused.
 */
export const RecordInputSchema = z.strictObject({
  suite: z.string().min(1).max(80),
  caseId: EvalCaseSchema.shape.id,
  description: z.string().max(500).optional(),
  threshold: z.number().min(0).max(1).default(CLASSIFY_MIN_CONFIDENCE_DEFAULT),
  departments: z.array(CatalogueDepartmentSchema),
  categories: z.array(CatalogueCategorySchema).optional(),
  ticket: z.strictObject(
    {
      externalId: z.string().trim().min(1).max(200),
      subject: z.string().trim().min(1).max(300),
      body: z.string().max(20_000),
      channel: z.string().trim().min(1).max(64),
    },
    { error: (issue) => (issue.code === 'unrecognized_keys' ? 'A recorded ticket has no email or other extra field.' : undefined) },
  ),
  expect: ExpectationSchema,
});
export type RecordInput = z.input<typeof RecordInputSchema>;

/** The environment the recorder reads: the same variables the agent reads. */
const RECORD_ENV_KEYS = ['OLLAMA_HOST', 'OLLAMA_MODEL', 'OLLAMA_TOKEN'] as const;

export interface RecordResult {
  /** The draft suite file (one golden case with the recorded reply), or null when the model gave no answer. */
  readonly file: SuiteFile | null;
  readonly actual: Outcome;
  /** Reasons the live answer does not meet the human expectation; empty when it does. */
  readonly problems: readonly string[];
}

/**
 * Runs one classify through the real `createAgentHost` (real instruction, real ADK
 * classifier) in a temporary database, captures the raw assistant message with the
 * host's `onModelReply` hook, and builds a draft suite file. Never logs the reply, the
 * token, or the server URL. The fallback model is disabled while recording.
 */
export async function recordCase(
  raw: unknown,
  options: { readonly env: NodeJS.ProcessEnv; readonly fetch?: typeof fetch },
): Promise<RecordResult> {
  const input = RecordInputSchema.parse(raw);
  const env: NodeJS.ProcessEnv = { CLASSIFY_MIN_CONFIDENCE: String(input.threshold), OLLAMA_FALLBACK_MODEL: '' };
  for (const key of RECORD_ENV_KEYS) if (options.env[key] !== undefined) env[key] = options.env[key];

  const dir = mkdtempSync(join(tmpdir(), 'ticket-record-'));
  const db = openTicketDatabase(join(dir, 'tickets.db'));
  let reply: { content: string; model: string; recordedAt: string } | null = null;
  try {
    const host = createAgentHost({
      db,
      env,
      ...(options.fetch && { fetch: options.fetch }),
      onModelReply: (captured) => {
        reply = { content: captured.content, model: captured.model, recordedAt: captured.recordedAt };
      },
    });
    for (const department of input.departments) {
      const { active, ...create } = department;
      host.createDepartment(create);
      if (!active) host.updateDepartment({ id: department.id, active: false });
    }
    for (const category of input.categories ?? []) {
      const { active, ...create } = category;
      host.createCategory(create);
      if (!active) host.updateCategory({ id: category.id, active: false });
    }
    const view = await host.classify(input.ticket);
    const { decision } = view;
    const actual: Outcome = {
      status: decision.status,
      departmentId: decision.status === 'labeled' ? decision.departmentId : null,
      confidence: decision.confidence,
      quote: decision.quote,
      taxonomyVersion: decision.taxonomyVersion,
      categoryId: decision.categoryId,
      priority: decision.priority,
    };
    // systemIncludes/systemExcludes cannot be checked here: the instruction is not captured.
    const problems = judge(input.expect, actual, input.threshold);
    const captured = reply as { content: string; model: string; recordedAt: string } | null;
    if (!captured) return { file: null, actual, problems };
    const file = parseSuiteFile('recorded draft', {
      formatVersion: SUITE_FORMAT_VERSION,
      suite: input.suite,
      threshold: input.threshold,
      catalogues: { recorded: input.departments },
      ...(input.categories && { categories: { recorded: input.categories } }),
      cases: [
        {
          id: input.caseId,
          source: 'golden',
          ...(input.description && { description: input.description }),
          catalogue: 'recorded',
          ticket: input.ticket,
          reply: { kind: 'recorded', content: captured.content, model: captured.model, recordedAt: captured.recordedAt },
          // The human-written expectation, unchanged.
          expect: input.expect,
        },
      ],
    });
    return { file, actual, problems };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One line per judged field: ids and codes only, no ticket text, no model output. */
export function comparisonLines(expected: RecordInput['expect'], actual: Outcome): string[] {
  const row = (name: string, want: unknown, got: unknown) =>
    `${name.padEnd(10)} expected ${String(want ?? 'none').padEnd(14)} actual ${String(got ?? 'none')}${want === got ? '' : '   ← differs'}`;
  const lines = [row('status', expected.status, actual.status), row('department', expected.departmentId, actual.departmentId)];
  if (expected.categoryId !== undefined) lines.push(row('category', expected.categoryId, actual.categoryId));
  if (expected.priority !== undefined) lines.push(row('priority', expected.priority, actual.priority));
  return lines;
}
