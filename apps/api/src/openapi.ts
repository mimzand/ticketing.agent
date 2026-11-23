import {
  ApiHealthSchema,
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DeleteDepartmentResultSchema,
  DepartmentIdSchema,
  DepartmentSchema,
  TicketViewSchema,
} from '@ticket/shared';
import { z } from 'zod';

/** Header name shown in Swagger. Lookup in the server is case-insensitive. */
export const API_KEY_HEADER = 'X-API-Key';

const ErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

/** PATCH body. The id stays in the path because decisions store it. */
const UpdateDepartmentBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  active: z.boolean().optional(),
});

const OverrideBodySchema = z.strictObject({
  departmentId: DepartmentIdSchema,
});

type JsonSchema = Record<string, unknown>;

interface ResponseSpec {
  readonly description: string;
  readonly schema?: z.ZodType;
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
    auth: true,
    body: CreateDepartmentSchema,
    responses: {
      '200': { description: 'The created department. New departments are active.', schema: DepartmentSchema },
      '400': badRequest,
      ...authedErrors,
    },
  },
  {
    method: 'patch',
    path: '/v1/departments/{id}',
    tag: 'Departments',
    summary: 'Edit a department',
    description: 'Changes name, description, or active. The id cannot change.',
    auth: true,
    params: [{ name: 'id', schema: DepartmentIdSchema, description: 'Department id. Immutable.' }],
    body: UpdateDepartmentBodySchema,
    responses: {
      '200': { description: 'The updated department.', schema: DepartmentSchema },
      '400': badRequest,
      '404': notFound,
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
      'The same externalId returns the stored decision and does not call the model again. Low confidence or an unknown department is needs_review with no department applied.',
    auth: true,
    body: ClassifyTicketSchema,
    responses: {
      '200': { description: 'The stored ticket and its decision.', schema: TicketViewSchema },
      '400': badRequest,
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
        '/health, /docs, and /openapi.json are public.',
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
