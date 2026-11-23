import { AgentClientError, type AgentLink } from '@ticket/agent-client';
import {
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DepartmentSchema,
  OverrideTicketSchema,
  TicketViewSchema,
} from '@ticket/shared';
import { type Context } from 'hono';
import { type ContentfulStatusCode } from 'hono/utils/http-status';
import { type ZodType } from 'zod';

interface JsonResult {
  readonly status: ContentfulStatusCode;
  readonly body: unknown;
}

function paths(error: { issues: readonly { path: PropertyKey[] }[] }): string {
  return error.issues
    .map((issue) => issue.path.map(String).join('.') || '(root)')
    .slice(0, 10)
    .join(', ');
}

async function readBody<T>(c: Context, schema: ZodType<T>): Promise<T | JsonResult> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { status: 400, body: { error: { code: 'bad_request', message: 'The body must be JSON.' } } };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: { code: 'bad_request', message: `Invalid body at: ${paths(parsed.error)}.` } },
    };
  }
  return parsed.data;
}

function isJsonResult(value: unknown): value is JsonResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

async function forward(run: () => Promise<unknown>): Promise<JsonResult> {
  try {
    return { status: 200, body: await run() };
  } catch (error) {
    if (error instanceof AgentClientError && error.code === 'bad_request') {
      return { status: 400, body: { error: { code: 'bad_request', message: error.message } } };
    }
    if (
      error instanceof AgentClientError &&
      (error.code === 'not_running' || error.code === 'connect_failed' || error.code === 'connection_closed')
    ) {
      return { status: 503, body: { error: { code: 'agent_unavailable', message: 'The agent is not reachable.' } } };
    }
    return { status: 502, body: { error: { code: 'bad_gateway', message: 'The agent rejected the request.' } } };
  }
}

export async function listDepartments(agent: AgentLink): Promise<JsonResult> {
  return forward(async () => DepartmentSchema.array().parse(await agent.request('departments.list', {})));
}

export async function createDepartment(c: Context, agent: AgentLink): Promise<JsonResult> {
  const body = await readBody(c, CreateDepartmentSchema);
  if (isJsonResult(body)) return body;
  return forward(async () => DepartmentSchema.parse(await agent.request('departments.create', body)));
}

export async function classifyTicket(c: Context, agent: AgentLink): Promise<JsonResult> {
  const body = await readBody(c, ClassifyTicketSchema);
  if (isJsonResult(body)) return body;
  return forward(async () => TicketViewSchema.parse(await agent.request('tickets.classify', body)));
}

export async function listTickets(agent: AgentLink): Promise<JsonResult> {
  return forward(async () => TicketViewSchema.array().parse(await agent.request('tickets.list', {})));
}

export async function overrideTicket(c: Context, agent: AgentLink, id: string): Promise<JsonResult> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = OverrideTicketSchema.safeParse({ ...(typeof raw === 'object' && raw ? raw : {}), id });
  if (!parsed.success) {
    return { status: 400, body: { error: { code: 'bad_request', message: `Invalid body at: ${paths(parsed.error)}.` } } };
  }
  return forward(async () => TicketViewSchema.parse(await agent.request('tickets.override', parsed.data)));
}
