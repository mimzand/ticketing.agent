import { type AgentLink } from '@ticket/agent-client';
import { ApiHealthSchema, type ApiHealth } from '@ticket/shared';
import { Hono } from 'hono';
import { mountDocs } from './docs.js';
import { openApiDocument } from './openapi.js';
import {
  classifyTicket,
  createDepartment,
  deleteDepartment,
  listDepartments,
  listTickets,
  overrideTicket,
  updateDepartment,
} from './routes.js';
import {
  classifyRateLimit,
  corsAllowlist,
  createRateLimiter,
  type RateLimiter,
} from './limits.js';
import { apiKeyAuth } from './security.js';

/** How long `/health` waits for the agent. */
export const HEALTH_PING_TIMEOUT_MS = 2_000;

export interface ApiDeps {
  readonly agent: AgentLink;
  readonly apiKey: string;
  /** CORS_ORIGINS, parsed. Empty: no browser cross-origin call is allowed. */
  readonly corsOrigins?: readonly string[];
  /** Tests: a limiter with a fake clock. Default: 30 classify requests per minute per key. */
  readonly rateLimiter?: RateLimiter;
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
  // Order: CORS (answers preflights, which carry no key), the API key, then the
  // classify rate limit, so a missing key is a 401 and never counted.
  app.use('*', corsAllowlist(deps.corsOrigins ?? []));
  app.use('*', apiKeyAuth(deps.apiKey));
  app.use('*', classifyRateLimit(deps.rateLimiter ?? createRateLimiter()));

  app.get('/health', async (c) => c.json(await readHealth(deps.agent)));

  app.get('/v1/departments', async (c) => {
    const result = await listDepartments(deps.agent);
    return c.json(result.body, result.status);
  });
  app.post('/v1/departments', async (c) => {
    const result = await createDepartment(c, deps.agent);
    return c.json(result.body, result.status);
  });
  app.patch('/v1/departments/:id', async (c) => {
    const result = await updateDepartment(c, deps.agent, c.req.param('id'));
    return c.json(result.body, result.status);
  });
  app.delete('/v1/departments/:id', async (c) => {
    const result = await deleteDepartment(deps.agent, c.req.param('id'));
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

  mountDocs(app, openApiDocument);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404));
  app.onError((error, c) => {
    log(`[api] ${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json({ error: { code: 'internal', message: 'Internal error.' } }, 500);
  });

  return app;
}
