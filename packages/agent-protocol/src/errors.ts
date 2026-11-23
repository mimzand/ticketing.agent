import { z } from 'zod';

/**
 * Codes carried by `error` envelopes. Messages are short and fixed-shape: they never
 * echo payload values, which may hold the token or ticket text.
 */
export const PROTOCOL_ERROR_CODES = [
  /** Not JSON, too large, or not a valid envelope. The connection is closed. */
  'bad_frame',
  /** The envelope is valid but its payload fails the method's schema. */
  'bad_request',
  /** No handshake yet, a malformed hello, or a wrong token. The connection is closed. */
  'unauthorized',
  /** The hello asked for a protocol version this side does not speak. */
  'unsupported_version',
  /** The method is not in the registry. */
  'unknown_method',
  'timeout',
  'internal',
] as const;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorSchema = z.strictObject({
  code: ProtocolErrorCodeSchema,
  message: z.string().max(2000),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const protocolError = (code: ProtocolErrorCode, message: string): ProtocolError => ({
  code,
  message,
});

/** Issue paths only, never values, so a validation error cannot leak payload content. */
export function describeIssues(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.map(String).join('.') || '(root)');
  return [...new Set(paths)].slice(0, 10).join(', ');
}
