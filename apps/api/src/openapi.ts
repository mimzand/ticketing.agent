import {
  ApiHealthSchema,
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DeleteDepartmentResultSchema,
  DepartmentChangesSchema,
  DepartmentIdSchema,
  DepartmentSchema,
  MergeSendersResultSchema,
  MergeSendersSchema,
  TicketViewSchema,
} from '@ticket/shared';
import { z } from 'zod';
import { CLASSIFY_RATE_LIMIT, CORS_ALLOWED_HEADERS } from './limits.js';

/** Header name shown in Swagger. Lookup in the server is case-insensitive. */
export const API_KEY_HEADER = 'X-API-Key';

const ErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

/** PATCH body: the same Zod schema the agent applies, without the id (it stays in the path). */
const UpdateDepartmentBodySchema = DepartmentChangesSchema;

const OverrideBodySchema = z.strictObject({
  departmentId: DepartmentIdSchema,
});

type JsonSchema = Record<string, unknown>;

interface ResponseSpec {
  readonly description: string;
  readonly schema?: z.ZodType;
  readonly headers?: Readonly<Record<string, { readonly description: string; readonly schema: JsonSchema }>>;
}

interface Operation {
  readonly method: 'get' | 'post' | 'patch' | 'delete';
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  readonly auth: boolean;
  readonly params?: readonly { readonly name: string; readonly schema: z.ZodType; readonly description: string }[];
  readonly body?: z.ZodType;
  readonly responses: Readonly<Record<string, ResponseSpec>>;
}

const unauthorized: ResponseSpec = {
  description: 'Missing or wrong API key.',
  schema: ErrorSchema,
};
const badRequest: ResponseSpec = { description: 'The body or the path is invalid.', schema: ErrorSchema };
const notFound: ResponseSpec = { description: 'No such record.', schema: ErrorSchema };
const conflict: ResponseSpec = {
  description: 'A ticket decision still references this department. Deactivate it instead.',
  schema: ErrorSchema,
};
const rateLimited: ResponseSpec = {
  description: `More than ${CLASSIFY_RATE_LIMIT} classify requests in one minute for this API key. error.code is rate_limited.`,
  schema: ErrorSchema,
  headers: { 'Retry-After': { description: 'Seconds until a request is accepted again.', schema: { type: 'integer', minimum: 1 } } },
};
const badGateway: ResponseSpec = { description: 'The agent rejected the request.', schema: ErrorSchema };
const unavailable: ResponseSpec = { description: 'The agent is not reachable.', schema: ErrorSchema };

const authedErrors = { '401': unauthorized, '502': badGateway, '503': unavailable };

const operations: readonly Operation[] = [
  {
    method: 'get',
    path: '/health',
    tag: 'Health',
    summary: 'Agent and Ollama reachability',
    description: 'Public. Carries no token, port, or API key. model is empty when the agent cannot be asked.',
    auth: false,
    responses: { '200': { description: 'The API is up.', schema: ApiHealthSchema } },
  },
  {
    method: 'get',
    path: '/v1/departments',
    tag: 'Departments',
    summary: 'List departments',
    auth: true,
    responses: {
      '200': { description: 'Every department, including inactive ones.', schema: z.array(DepartmentSchema) },
      ...authedErrors,
    },
  },
  {
    method: 'post',
    path: '/v1/departments',
    tag: 'Departments',
    summary: 'Create a department',
    description: 'Aliases and examples are optional. A new department records a new taxonomy version.',
    auth: true,
    body: CreateDepartmentSchema,
    responses: {
      '200': { description: 'The created department. New departments are active.', schema: DepartmentSchema },
      '400': badRequest,
      '409': { description: 'The id exists, or an alias already belongs to another department.', schema: ErrorSchema },
      ...authedErrors,
    },
  },
  {
    method: 'patch',
    path: '/v1/departments/{id}',
    tag: 'Departments',
    summary: 'Edit a department',
    description:
      'Changes name, description, active, aliases, or examples. Lists replace the stored lists. The id cannot change. ' +
      'An alias is 1–64 characters, at most 20 per department, and cannot belong to two departments (409). ' +
      'An example is at most 300 characters, at most 20 per department. A real change records a new taxonomy version.',
    auth: true,
    params: [{ name: 'id', schema: DepartmentIdSchema, description: 'Department id. Immutable.' }],
    body: UpdateDepartmentBodySchema,
    responses: {
      '200': { description: 'The updated department.', schema: DepartmentSchema },
      '400': badRequest,
      '404': notFound,
      '409': { description: 'An alias already belongs to another department.', schema: ErrorSchema },
      ...authedErrors,
    },
  },
  {
    method: 'delete',
    path: '/v1/departments/{id}',
    tag: 'Departments',
    summary: 'Remove a department',
    description: 'Refused while any ticket decision references the id.',
    auth: true,
    params: [{ name: 'id', schema: DepartmentIdSchema, description: 'Department id.' }],
    responses: {
      '200': { description: 'The department was removed.', schema: DeleteDepartmentResultSchema },
      '400': badRequest,
      '404': notFound,
      '409': conflict,
      ...authedErrors,
    },
  },
  {
    method: 'post',
    path: '/v1/tickets:classify',
    tag: 'Tickets',
    summary: 'Classify a ticket',
    description:
      'The same externalId returns the stored decision (and its quote) and does not call the model again. ' +
      'Low confidence or an unknown department is needs_review with no department applied. ' +
      'decision.quote is an exact substring of the subject or body (at most 240 characters) or null. ' +
      'decision.taxonomyVersion is the department catalogue version the classify used. ' +
      'email is optional: one address, trimmed and compared case-insensitively (400 otherwise). ' +
      'With it, the agent gives the classifier up to 5 earlier decided tickets of that address (subject, channel, status, department, quote, time; no body) as untrusted data. ' +
      'Without it the sender is unknown and there is no memory. An address inside the subject or body is never used. ' +
      'A repeated externalId never calls the model again; an email on the repeat is only attached when the stored ticket had none. ' +
      `Limited to ${CLASSIFY_RATE_LIMIT} requests per minute per API key (429 with Retry-After).`,
    auth: true,
    body: ClassifyTicketSchema,
    responses: {
      '200': { description: 'The stored ticket and its decision.', schema: TicketViewSchema },
      '400': badRequest,
      '429': rateLimited,
      ...authedErrors,
    },
  },
  {
    method: 'post',
    path: '/v1/senders:merge',
    tag: 'Senders',
    summary: 'Merge two senders',
    description:
      'An operator action. Every ticket of `from` moves onto `into` (created if it has no tickets yet), and `from` is removed. ' +
      'Decisions are kept exactly as they are. Two addresses stay two people until they are merged.',
    auth: true,
    body: MergeSendersSchema,
    responses: {
      '200': { description: 'The address the tickets now belong to, and how many moved.', schema: MergeSendersResultSchema },
      '400': badRequest,
      '404': { description: 'No ticket is linked to the `from` address.', schema: ErrorSchema },
      ...authedErrors,
    },
  },
  {
    method: 'get',
    path: '/v1/tickets',
    tag: 'Tickets',
    summary: 'List recent tickets',
    description: 'The 50 most recent tickets.',
    auth: true,
    responses: {
      '200': { description: 'Recent tickets, newest first.', schema: z.array(TicketViewSchema) },
      ...authedErrors,
    },
  },
  {
    method: 'post',
    path: '/v1/tickets/{id}/override',
    tag: 'Tickets',
    summary: 'Override a ticket department',
    description: 'The department must be active. Sets the decision status to overridden.',
    auth: true,
    params: [{ name: 'id', schema: z.uuid(), description: 'Ticket id.' }],
    body: OverrideBodySchema,
    responses: {
      '200': { description: 'The ticket after the override.', schema: TicketViewSchema },
      '400': badRequest,
      '404': notFound,
      ...authedErrors,
    },
  },
];

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline' }) as JsonSchema;
  delete out['$schema'];
  return out;
}

function operationId(operation: Operation): string {
  return `${operation.method}${operation.path.replace(/[{}]/g, '').replace(/[/:](\w)/g, (_, ch: string) => ch.toUpperCase())}`;
}

/** OpenAPI 3.1 for the ticket routes. Schemas come from the same Zod types the handlers parse. */
export function openApiDocument(): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const responses: Record<string, unknown> = {};
    for (const [status, spec] of Object.entries(operation.responses)) {
      responses[status] = {
        description: spec.description,
        ...(spec.headers && { headers: spec.headers }),
        ...(spec.schema && { content: { 'application/json': { schema: jsonSchema(spec.schema, 'output') } } }),
      };
    }
    (paths[operation.path] ??= {})[operation.method] = {
      tags: [operation.tag],
      summary: operation.summary,
      ...(operation.description && { description: operation.description }),
      operationId: operationId(operation),
      security: operation.auth ? [{ apiKey: [] }, { bearer: [] }] : [],
      parameters: (operation.params ?? []).map((param) => ({
        name: param.name,
        in: 'path',
        required: true,
        description: param.description,
        schema: jsonSchema(param.schema, 'input'),
      })),
      ...(operation.body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: jsonSchema(operation.body, 'input') } },
        },
      }),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ticketing Agent API',
      version: '0.1.0',
      description:
        'HTTP API for the local ticketing agent. The API forwards to the agent over its loopback protocol. ' +
        'The agent token and the Ollama token are never returned. Send the API key in the X-API-Key header or as a Bearer token. ' +
        '/health, /docs, and /openapi.json are public and not rate limited. ' +
        `Browsers may call it only from the origins in CORS_ORIGINS (empty by default); allowed request headers: ${CORS_ALLOWED_HEADERS.join(', ')}.`,
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: API_KEY_HEADER },
        bearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}
