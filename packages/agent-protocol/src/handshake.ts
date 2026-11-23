import { err, ok, type Result } from '@ticket/shared';
import { z } from 'zod';
import { type Envelope } from './envelope.js';
import { protocolError, type ProtocolError } from './errors.js';

export const PROTOCOL_NAME = 'ticket-agent';
export const PROTOCOL_VERSION = 1;

/** The only host the agent binds to and the only host a state file may name. */
export const AGENT_LOOPBACK_HOST = '127.0.0.1';

/** A client that has not finished the handshake in this time is disconnected. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Session token: at least 32 random bytes, base64url (43+ characters). Fresh per agent start. */
export const AgentTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

export const ClientKindSchema = z.enum(['shell', 'cli', 'test']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/**
 * Params of `system.hello`, the client's required first request. `version` is any
 * positive integer so a mismatch is answered with `unsupported_version`.
 */
export const HelloRequestSchema = z.strictObject({
  protocol: z.literal(PROTOCOL_NAME),
  version: z.int().min(1),
  token: AgentTokenSchema,
  client: z.strictObject({
    kind: ClientKindSchema,
    version: z.string().min(1).max(64),
  }),
});
export type HelloRequest = z.infer<typeof HelloRequestSchema>;

export const HelloAckSchema = z.strictObject({
  protocol: z.literal(PROTOCOL_NAME),
  version: z.literal(PROTOCOL_VERSION),
  agent: z.strictObject({
    pid: z.int().positive(),
    version: z.string().min(1).max(64),
    startedAt: z.iso.datetime(),
  }),
});
export type HelloAck = z.infer<typeof HelloAckSchema>;

/**
 * The file the agent writes on start so clients can find it. `host` is the literal
 * 127.0.0.1: a file naming any other host fails validation.
 */
export const AgentStateFileSchema = z.strictObject({
  protocol: z.literal(PROTOCOL_NAME),
  version: z.literal(PROTOCOL_VERSION),
  host: z.literal(AGENT_LOOPBACK_HOST),
  port: z.int().min(1).max(65_535),
  token: AgentTokenSchema,
  pid: z.int().positive(),
  startedAt: z.iso.datetime(),
});
export type AgentStateFile = z.infer<typeof AgentStateFileSchema>;

/**
 * Checks that the first envelope of a connection is a well-formed `system.hello`.
 * Does not compare the token: the server does that in constant time.
 */
export function parseHello(
  envelope: Envelope,
): Result<{ readonly id: string; readonly hello: HelloRequest }, ProtocolError> {
  if (envelope.kind !== 'req' || envelope.method !== 'system.hello') {
    return err(protocolError('unauthorized', 'The first message must be a system.hello request.'));
  }
  const parsed = HelloRequestSchema.safeParse(envelope.payload);
  if (!parsed.success) return err(protocolError('unauthorized', 'Malformed system.hello.'));
  if (parsed.data.version !== PROTOCOL_VERSION) {
    return err(
      protocolError(
        'unsupported_version',
        `Protocol version ${parsed.data.version} is not supported (expected ${PROTOCOL_VERSION}).`,
      ),
    );
  }
  return ok({ id: envelope.id, hello: parsed.data });
}
