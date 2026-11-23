import { type AgentLink } from '@ticket/agent-client';
import { describe, expect, it } from 'vitest';
import { createApiApp } from './app.js';
import { createRateLimiter, parseCorsOrigins } from './limits.js';

const API_KEY = 'limits-test-key';
const ticketView = {
  id: '00000000-0000-4000-8000-000000000001',
  externalId: 'x',
  subject: 'Invoice',
  body: 'Body',
  channel: 'api',
  createdAt: '2026-01-01T00:00:00.000Z',
  email: null,
  decision: {
    departmentId: 'billing',
    confidence: 0.9,
    rationale: 'Invoice.',
    status: 'labeled',
    quote: 'Invoice',
    taxonomyVersion: 1,
  },
};

/** A stand-in agent: the limits live in the API, so no real agent is needed. */
const agent = {
  request: (method: string) => {
    if (method === 'tickets.classify') return Promise.resolve(ticketView);
    if (method === 'settings.get') return Promise.reject(new Error('not needed'));
    if (method === 'model.health') return Promise.resolve({ reachable: true, model: 'test-model' });
    return Promise.resolve([]);
  },
  ping: () => Promise.resolve({ pid: 1, version: '0.1.0', protocolVersion: 1 }),
  close: () => undefined,
} as unknown as AgentLink;

function appWith(options: { corsOrigins?: readonly string[]; now?: () => number } = {}) {
  return createApiApp({
    agent,
    apiKey: API_KEY,
    corsOrigins: options.corsOrigins ?? [],
    rateLimiter: createRateLimiter(options.now ? { now: options.now } : {}),
    log: () => undefined,
  });
}

const classify = (app: ReturnType<typeof appWith>, headers: Record<string, string> = { 'x-api-key': API_KEY }) =>
  app.request('/v1/tickets:classify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ externalId: 'x', subject: 'Invoice', body: 'Body', channel: 'api' }),
  });

describe('CORS', () => {
  const app = appWith({ corsOrigins: parseCorsOrigins('https://intranet.example.com, http://localhost:5173') });

  it('gives a listed origin exactly that origin', async () => {
    const response = await app.request('/health', { headers: { origin: 'https://intranet.example.com' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://intranet.example.com');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('gives an unlisted origin no allow-origin header', async () => {
    const response = await app.request('/health', { headers: { origin: 'https://evil.example.com' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a listed preflight with the accepted headers, and an unlisted one with none', async () => {
    const preflight = (origin: string) =>
      app.request('/v1/tickets:classify', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key' },
      });
    const listed = await preflight('http://localhost:5173');
    expect(listed.status).toBe(204);
    expect(listed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(listed.headers.get('access-control-allow-headers')).toBe('Content-Type, X-API-Key, Authorization');
    const unlisted = await preflight('http://localhost:9999');
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull();
    expect(unlisted.headers.get('access-control-allow-headers')).toBeNull();
  });

  it('allows no browser origin by default and never uses *', async () => {
    const response = await appWith().request('/health', { headers: { origin: 'https://intranet.example.com' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(() => parseCorsOrigins('*')).toThrow(/not allowed/);
    expect(() => parseCorsOrigins('https://a.example.com/path')).toThrow();
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });
});

describe('classify rate limit', () => {
  it('the 31st classify in a minute is 429 with Retry-After; /health is not limited', async () => {
    let now = 1_000_000;
    const app = appWith({ now: () => now });
    for (let i = 0; i < 30; i += 1) {
      expect((await classify(app)).status).toBe(200);
      now += 100;
    }
    const limited = await classify(app);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    for (let i = 0; i < 40; i += 1) expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/openapi.json')).status).toBe(200);
    // Other routes are not limited.
    expect((await app.request('/v1/tickets', { headers: { 'x-api-key': API_KEY } })).status).toBe(200);

    // A minute after the first request, the window has room again.
    now = 1_000_000 + 60_001;
    expect((await classify(app)).status).toBe(200);
  });

  it('a missing or wrong key is 401 and is not counted', async () => {
    const app = appWith();
    for (let i = 0; i < 40; i += 1) {
      expect((await classify(app, {})).status).toBe(401);
      expect((await classify(app, { 'x-api-key': 'wrong' })).status).toBe(401);
    }
    expect((await classify(app)).status).toBe(200);
  });
});
