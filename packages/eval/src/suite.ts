import {
  CLASSIFY_MIN_CONFIDENCE_DEFAULT,
  ClassifyTicketSchema,
  DepartmentAliasesSchema,
  DepartmentExamplesSchema,
  DepartmentIdSchema,
  DepartmentSchema,
} from '@ticket/shared';
import { z } from 'zod';

/** The suite file format. Bump only with a migration of every checked-in file. */
export const SUITE_FORMAT_VERSION = 1;

/** One department of a catalogue a case runs against. Inactive ones are created, then deactivated. */
export const CatalogueDepartmentSchema = z.strictObject({
  id: DepartmentIdSchema,
  name: DepartmentSchema.shape.name,
  description: DepartmentSchema.shape.description,
  active: z.boolean().default(true),
  aliases: DepartmentAliasesSchema.default([]),
  examples: DepartmentExamplesSchema.default([]),
});
export type CatalogueDepartment = z.infer<typeof CatalogueDepartmentSchema>;

/**
 * What the fake Ollama answers for one chat request.
 * - `scripted`: `output` is serialized as the assistant message (it may break the schema on purpose).
 * - `recorded`: `content` is the assistant message text exactly as a real model returned it.
 * - `error`: Ollama answers this HTTP status (the decision is `failed`).
 */
export const ModelReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scripted'), output: z.unknown() }),
  z.strictObject({
    kind: z.literal('recorded'),
    content: z.string().max(50_000),
    model: z.string().min(1).max(256).optional(),
    recordedAt: z.iso.datetime().optional(),
  }),
  z.strictObject({ kind: z.literal('error'), status: z.int().min(400).max(599) }),
]);
export type ModelReply = z.infer<typeof ModelReplySchema>;

/** A ticket the same sender sent earlier: classified first (and optionally overridden). */
export const HistoryEntrySchema = z.strictObject({
  ticket: ClassifyTicketSchema,
  reply: ModelReplySchema,
  override: DepartmentIdSchema.optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** The decision a case expects. Only fresh classify outcomes: never `overridden`. */
export const ExpectationSchema = z
  .strictObject({
    status: z.enum(['labeled', 'needs_review', 'failed']),
    departmentId: DepartmentIdSchema.nullable(),
    /** Whether the stored confidence is at/above or below the suite threshold. */
    confidence: z.enum(['above', 'below']).optional(),
    /** The stored quote (null when it must be dropped). */
    quote: z.string().min(1).nullable().optional(),
  })
  .refine((e) => (e.status === 'labeled') === (e.departmentId !== null), {
    message: 'departmentId is set exactly when status is labeled.',
    path: ['departmentId'],
  });
export type Expectation = z.infer<typeof ExpectationSchema>;

/** Where an override case came from. Synthetic ids only in checked-in files. */
export const OverrideOriginSchema = z.strictObject({
  ticketId: z.uuid(),
  replacedDepartmentId: DepartmentIdSchema,
  taxonomyVersion: z.int().min(0),
});

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'A case id is lowercase letters, digits, dots, dashes, underscores.'),
  /** `golden`: written by hand. `override`: generated from an operator override. */
  source: z.enum(['golden', 'override']),
  description: z.string().max(500).optional(),
  /** Key into the file's `catalogues`. */
  catalogue: z.string().min(1).max(64),
  history: z.array(HistoryEntrySchema).max(5).default([]),
  ticket: ClassifyTicketSchema,
  reply: ModelReplySchema,
  /**
   * Optional counter-check: with this reply instead, the expectation must NOT hold.
   * Override cases put the classifier's original answer here.
   */
  wrongReply: ModelReplySchema.optional(),
  expect: ExpectationSchema,
  origin: OverrideOriginSchema.optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const SuiteFileSchema = z
  .strictObject({
    formatVersion: z.literal(SUITE_FORMAT_VERSION),
    suite: z.string().min(1).max(80),
    /** CLASSIFY_MIN_CONFIDENCE for every case of this file. */
    threshold: z.number().min(0).max(1).default(CLASSIFY_MIN_CONFIDENCE_DEFAULT),
    catalogues: z.record(z.string().min(1).max(64), z.array(CatalogueDepartmentSchema)),
    cases: z.array(EvalCaseSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.cases.forEach((c, index) => {
      const path = ['cases', index];
      if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `Duplicate case id ${c.id}.`, path: [...path, 'id'] });
      ids.add(c.id);
      const catalogue = file.catalogues[c.catalogue];
      if (!catalogue) {
        ctx.addIssue({ code: 'custom', message: `Unknown catalogue ${c.catalogue}.`, path: [...path, 'catalogue'] });
        return;
      }
      if (c.expect.departmentId !== null && !catalogue.some((d) => d.id === c.expect.departmentId && d.active)) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected department ${c.expect.departmentId} is not active in ${c.catalogue}.`,
          path: [...path, 'expect', 'departmentId'],
        });
      }
      if ((c.source === 'override') !== (c.origin !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'origin is set exactly for override cases.', path: [...path, 'origin'] });
      }
      if (c.history.length > 0 && !c.ticket.email) {
        ctx.addIssue({ code: 'custom', message: 'History needs the ticket email.', path: [...path, 'ticket', 'email'] });
      }
      c.history.forEach((h, at) => {
        if (h.ticket.email !== c.ticket.email) {
          ctx.addIssue({ code: 'custom', message: 'A history ticket must have the case email.', path: [...path, 'history', at] });
        }
      });
    });
  });
export type SuiteFile = z.infer<typeof SuiteFileSchema>;
export type SuiteFileInput = z.input<typeof SuiteFileSchema>;

/** Parses one suite file; the error names the file and the first few issue paths. */
export function parseSuiteFile(name: string, raw: unknown): SuiteFile {
  const parsed = SuiteFileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`${name} is not a valid suite file: ${issues}`);
}
