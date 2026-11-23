import { err, ok, type Result } from '@ticket/shared';
import { z } from 'zod';
import { describeIssues, protocolError, ProtocolErrorSchema, type ProtocolError } from './errors.js';

/** Every frame: a 4-byte unsigned big-endian body length, then that many bytes of UTF-8 JSON. */
export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Request ids are chosen by the sender; `res` and `error` echo the id they answer. */
export const MessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `namespace.name` in lower camel case, e.g. `system.ping`. */
export const MethodNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/);

/** Method of an `error` that answers no readable request (e.g. a frame that is not JSON). */
export const UNATTRIBUTED_ERROR_METHOD = 'system.error';

const fields = { id: MessageIdSchema, method: MethodNameSchema, payload: z.unknown() };

export const RequestEnvelopeSchema = z.strictObject({ ...fields, kind: z.literal('req') });
export const ResponseEnvelopeSchema = z.strictObject({ ...fields, kind: z.literal('res') });
export const ErrorEnvelopeSchema = z.strictObject({
  ...fields,
  kind: z.literal('error'),
  payload: ProtocolErrorSchema,
});

/** The envelope layer checks shape only; payloads are validated per method (methods.ts). */
export const EnvelopeSchema = z.discriminatedUnion('kind', [
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Parses one frame body (already UTF-8 decoded) into an envelope. */
export function decodeEnvelope(text: string): Result<Envelope, ProtocolError> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(protocolError('bad_frame', 'Frame is not valid JSON.'));
  }
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return err(protocolError('bad_frame', `Invalid envelope at: ${describeIssues(parsed.error)}.`));
  }
  return ok(parsed.data);
}

/** Validates and serialises an envelope. Throws on an invalid envelope (a sender bug). */
export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(EnvelopeSchema.parse(envelope));
}
