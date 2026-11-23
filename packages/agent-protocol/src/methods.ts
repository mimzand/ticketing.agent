import {
  AgentPingSchema,
  ConnectionTestRequestSchema,
  ConnectionTestResultSchema,
  DeleteDepartmentResultSchema,
  DeleteDepartmentSchema,
  ModelListSchema,
  SetOllamaTokenSchema,
  SettingsPatchSchema,
  SettingsViewSchema,
  StorageInfoSchema,
  TaxonomyStateSchema,
  MergeSendersResultSchema,
  MergeSendersSchema,
  TicketContextRequestSchema,
  TicketContextSchema,
  TokenStateSchema,
  UpdateDepartmentSchema,
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DepartmentSchema,
  ModelHealthSchema,
  OverrideTicketSchema,
  OverrideFeedbackSchema,
  TicketViewSchema,
  err,
  ok,
  type Result,
} from '@ticket/shared';
import { z } from 'zod';
import { MessageIdSchema, type RequestEnvelope } from './envelope.js';
import { describeIssues, protocolError, type ProtocolError } from './errors.js';
import { HelloAckSchema, HelloRequestSchema } from './handshake.js';

/** Methods without parameters take `{}`. */
export const NoParamsSchema = z.strictObject({});

/** Every client → agent method, with its params and result schemas. */
export const PROTOCOL_METHODS = {
  'system.hello': { params: HelloRequestSchema, result: HelloAckSchema },
  'system.ping': { params: NoParamsSchema, result: AgentPingSchema },
  /** Shell only. The agent answers, removes its state file, and exits. */
  'system.shutdown': { params: NoParamsSchema, result: z.null() },
  /**
   * Cancels an in-flight request of this connection by its message id. The cancelled
   * request answers `cancelled`. `cancelled: false` when it had already finished.
   */
  'system.cancel': {
    params: z.strictObject({ id: MessageIdSchema }),
    result: z.strictObject({ cancelled: z.boolean() }),
  },
  'model.health': { params: NoParamsSchema, result: ModelHealthSchema },
  'departments.list': { params: NoParamsSchema, result: z.array(DepartmentSchema) },
  'departments.create': { params: CreateDepartmentSchema, result: DepartmentSchema },
  'departments.update': { params: UpdateDepartmentSchema, result: DepartmentSchema },
  'departments.taxonomy': { params: NoParamsSchema, result: TaxonomyStateSchema },
  'departments.delete': { params: DeleteDepartmentSchema, result: DeleteDepartmentResultSchema },
  'tickets.classify': { params: ClassifyTicketSchema, result: TicketViewSchema },
  'tickets.list': { params: NoParamsSchema, result: z.array(TicketViewSchema) },
  'tickets.override': { params: OverrideTicketSchema, result: TicketViewSchema },
  'tickets.context': { params: TicketContextRequestSchema, result: TicketContextSchema },
  /** Read only: overrides that replaced a classifier department, and the catalogue. No email. */
  'tickets.overrideFeedback': { params: NoParamsSchema, result: OverrideFeedbackSchema },
  'senders.merge': { params: MergeSendersSchema, result: MergeSendersResultSchema },
  'settings.get': { params: NoParamsSchema, result: SettingsViewSchema },
  'settings.update': { params: SettingsPatchSchema, result: SettingsViewSchema },
  /** Shell only. The token stays in the agent's memory; the result says only whether one is set. */
  'settings.setToken': { params: SetOllamaTokenSchema, result: TokenStateSchema },
  'settings.testConnection': { params: ConnectionTestRequestSchema, result: ConnectionTestResultSchema },
  'models.list': { params: NoParamsSchema, result: ModelListSchema },
  'storage.info': { params: NoParamsSchema, result: StorageInfoSchema },
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
