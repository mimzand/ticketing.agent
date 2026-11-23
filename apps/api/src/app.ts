import { type AgentLink } from '@ticket/agent-client';
import { ApiHealthSchema, type ApiHealth } from '@ticket/shared';
import { Hono } from 'hono';
import { classifyTicket, createDepartment, listDepartments, listTickets, overrideTicket } from './routes.js';
import { apiKeyAuth } from './security.js';

/** How long `/health` waits for the agent. */
export const HEALTH_PING_TIMEOUT_MS = 2_000;

export interface ApiDeps {
  readonly agent: AgentLink;
  readonly apiKey: string;
  readonly log?: (message: string) => void;
}

async function readHealth(agent: AgentLink): Promise<ApiHealth> {
  const down: ApiHealth = {
    ok: true,
    service: 'ticket-api',
    agent: 'unavailable',
    ollama: 'unreachable',
    model: '',
  };
  try {
    await agent.ping({ timeoutMs: HEALTH_PING_TIMEOUT_MS });
  } catch {
    return down;
  }
  try {
    const model = await agent.request('model.health', {}, { timeoutMs: HEALTH_PING_TIMEOUT_MS });
    return ApiHealthSchema.parse({
      ok: true,
      service: 'ticket-api',
      agent: 'connected',
      ollama: model.reachable ? 'reachable' : 'unreachable',
      model: model.model,
    });
  } catch {
    return ApiHealthSchema.parse({
      ok: true,
      service: 'ticket-api',
      agent: 'connected',
      ollama: 'unreachable',
      model: '',
    });
  }
}

/** The HTTP API. It opens no database and does not classify: it forwards to the agent. */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((message: string) => console.warn(message));

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', apiKeyAuth(deps.apiKey));

  app.get('/health', async (c) => c.json(await readHealth(deps.agent)));

  app.get('/v1/departments', async (c) => {
    const result = await listDepartments(deps.agent);
    return c.json(result.body, result.status);
  });
  app.post('/v1/departments', async (c) => {
    const result = await createDepartment(c, deps.agent);
    return c.json(result.body, result.status);
  });
  app.post('/v1/tickets:classify', async (c) => {
    const result = await classifyTicket(c, deps.agent);
    return c.json(result.body, result.status);
  });
  app.get('/v1/tickets', async (c) => {
    const result = await listTickets(deps.agent);
    return c.json(result.body, result.status);
  });
  app.post('/v1/tickets/:id/override', async (c) => {
    const result = await overrideTicket(c, deps.agent, c.req.param('id'));
    return c.json(result.body, result.status);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404));
  app.onError((error, c) => {
    log(`[api] ${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json({ error: { code: 'internal', message: 'Internal error.' } }, 500);
  });

  return app;
}
