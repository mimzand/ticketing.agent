import { ClassifierResponseError } from '@ticket/adk-runtime';
import { DecisionStatusSchema, DepartmentIdSchema, TicketPrioritySchema } from '@ticket/shared';
import { z } from 'zod';

/** Why a stored decision is `failed`. Fixed codes: never an exception message. */
export const DecisionFailureCodeSchema = z.enum([
  'network',
  'timeout',
  'http_4xx',
  'http_5xx',
  'redirect',
  'invalid_url',
  'invalid_response',
  'empty_response',
  'invalid_json',
  'schema_mismatch',
  'unknown',
]);
export type DecisionFailureCode = z.infer<typeof DecisionFailureCodeSchema>;

/**
 * One structured event per stored classify outcome. Counts, ids, and codes only: no
 * external id, ticket text, email, sender id, rationale, quote text, catalogue text,
 * model output, model name, token, or URL. Strict, so nothing else can be added.
 */
export const DecisionEventSchema = z.strictObject({
  event: z.literal('ticket_classified'),
  ticketId: z.uuid(),
  status: DecisionStatusSchema.exclude(['overridden']),
  departmentId: DepartmentIdSchema.nullable(),
  categoryId: DepartmentIdSchema.nullable(),
  priority: TicketPrioritySchema.nullable(),
  confidence: z.number().min(0).max(1),
  taxonomyVersion: z.int().min(0),
  historyCount: z.int().min(0),
  quoteAccepted: z.boolean(),
  durationMs: z.int().min(0),
  attempts: z.union([z.literal(1), z.literal(2)]),
  modelRole: z.enum(['primary', 'fallback']),
  failureCode: DecisionFailureCodeSchema.nullable(),
});
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

export function failureCodeOf(error: unknown): DecisionFailureCode {
  if (!(error instanceof ClassifierResponseError)) return 'unknown';
  if (error.code === 'http') {
    const status = error.httpStatus ?? 0;
    return status >= 400 && status < 500 ? 'http_4xx' : status >= 500 ? 'http_5xx' : 'unknown';
  }
  return error.code;
}

const RETRYABLE_HTTP = new Set([500, 502, 503, 504]);

/**
 * Whether a primary failure may try the fallback model: a network failure, HTTP
 * 500/502/503/504, an invalid or empty Ollama response, malformed JSON, or output that
 * fails the classifier schema. Never a timeout, a cancel, another HTTP status, a
 * redirect, an invalid URL, or anything unknown. Decided on typed codes only.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ClassifierResponseError)) return false;
  switch (error.code) {
    case 'network':
    case 'invalid_response':
    case 'empty_response':
    case 'invalid_json':
    case 'schema_mismatch':
      return true;
    case 'http':
      return error.httpStatus !== null && RETRYABLE_HTTP.has(error.httpStatus);
    default:
      return false;
  }
}
