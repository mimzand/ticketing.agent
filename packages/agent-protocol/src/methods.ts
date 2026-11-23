import {
  AgentPingSchema,
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DepartmentSchema,
  ModelHealthSchema,
  OverrideTicketSchema,
  TicketViewSchema,
  err,
  ok,
  type Result,
} from '@ticket/shared';
import { z } from 'zod';
import { type RequestEnvelope } from './envelope.js';
import { describeIssues, protocolError, type ProtocolError } from './errors.js';
import { HelloAckSchema, HelloRequestSchema } from './handshake.js';

/** Methods without parameters take `{}`. */
export const NoParamsSchema = z.strictObject({});

/** Every client → agent method, with its params and result schemas. */
export const PROTOCOL_METHODS = {
  'system.hello': { params: HelloRequestSchema, result: HelloAckSchema },
  'system.ping': { params: NoParamsSchema, result: AgentPingSchema },
  'model.health': { params: NoParamsSchema, result: ModelHealthSchema },
  'departments.list': { params: NoParamsSchema, result: z.array(DepartmentSchema) },
  'departments.create': { params: CreateDepartmentSchema, result: DepartmentSchema },
  'tickets.classify': { params: ClassifyTicketSchema, result: TicketViewSchema },
  'tickets.list': { params: NoParamsSchema, result: z.array(TicketViewSchema) },
  'tickets.override': { params: OverrideTicketSchema, result: TicketViewSchema },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type MethodName = keyof typeof PROTOCOL_METHODS;
export type RequestParams<M extends MethodName> = z.output<(typeof PROTOCOL_METHODS)[M]['params']>;
export type RequestParamsInput<M extends MethodName> = z.input<
  (typeof PROTOCOL_METHODS)[M]['params']
>;
export type RequestResult<M extends MethodName> = z.output<(typeof PROTOCOL_METHODS)[M]['result']>;

export type ParsedRequest = {
  [M in MethodName]: { readonly id: string; readonly method: M; readonly params: RequestParams<M> };
}[MethodName];

export const isMethodName = (name: string): name is MethodName =>
  Object.hasOwn(PROTOCOL_METHODS, name);

/** Validates a request's method and params. */
export function parseRequest(envelope: RequestEnvelope): Result<ParsedRequest, ProtocolError> {
  if (!isMethodName(envelope.method)) {
    return err(protocolError('unknown_method', `Unknown method: ${envelope.method}.`));
  }
  const parsed = PROTOCOL_METHODS[envelope.method].params.safeParse(envelope.payload);
  if (!parsed.success) {
    return err(
      protocolError('bad_request', `Invalid params at: ${describeIssues(parsed.error)}.`),
    );
  }
  return ok({ id: envelope.id, method: envelope.method, params: parsed.data } as ParsedRequest);
}

/** Validates a method's result (the agent before sending, the client after receiving). */
export function parseResult<M extends MethodName>(
  method: M,
  payload: unknown,
): Result<RequestResult<M>, ProtocolError> {
  const parsed = PROTOCOL_METHODS[method].result.safeParse(payload);
  if (!parsed.success) {
    return err(protocolError('internal', `Invalid ${method} result at: ${describeIssues(parsed.error)}.`));
  }
  return ok(parsed.data as RequestResult<M>);
}
