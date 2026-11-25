import { createAgentLink, type AgentLink } from '@ticket/agent-client';
import { ApiHealthSchema, OverrideFeedbackSchema } from '@ticket/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from './index.js';

/*
 * End to end: a real agent process (apps/agent/src/main.ts, started with tsx), the
 * API's own agent link, and the Hono app. The API code under test never imports
 * the agent; the test only launches it as a separate process.
 */
const AGENT_MAIN = resolve(import.meta.dirname, '..', '..', 'agent', 'src', 'main.ts');

let dir: string;
let stateFile: string;
let agentProcess: ChildProcess | undefined;
let link: AgentLink;

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the agent.');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startAgent(): Promise<void> {
  // Windows kill does not run the agent's shutdown, so a previous state file can
  // still be there. Remove it and wait for the new process to publish its own.
  if (existsSync(stateFile)) rmSync(stateFile);
  agentProcess = spawn(process.execPath, ['--import', 'tsx', AGENT_MAIN], {
    cwd: resolve(AGENT_MAIN, '..', '..'),
    env: {
      ...process.env,
      AGENT_STATE_FILE: stateFile,
      OLLAMA_HOST: 'http://127.0.0.1:1',
      OLLAMA_MODEL: 'test-model',
      TICKET_DATA_DIR: join(dir, 'tickets.db'),
    },
    stdio: 'ignore',
  });
  await waitFor(() => existsSync(stateFile));
}

async function stopAgent(): Promise<void> {
  const child = agentProcess;
  agentProcess = undefined;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
}

const API_KEY = 'test-api-key';

async function getHealth(): Promise<{ status: number; body: unknown }> {
  const app = createApiApp({ agent: link, apiKey: API_KEY, log: () => undefined });
  const response = await app.request('/health');
  return { status: response.status, body: await response.json() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket-api-'));
  stateFile = join(dir, 'agent-state.json');
  link = createAgentLink({ stateFile, client: { kind: 'test', version: '0.0.0' } });
});

afterAll(async () => {
  link.close();
  await stopAgent();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('matches the schema and reports unavailable when no agent is running', async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(ApiHealthSchema.parse(body)).toEqual({
      ok: true,
      service: 'ticket-api',
      agent: 'unavailable',
      ollama: 'unreachable',
      model: '',
    });
  });

  it('matches the schema and reports connected when the agent is up', async () => {
    await startAgent();
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(ApiHealthSchema.parse(body)).toEqual({
      ok: true,
      service: 'ticket-api',
      agent: 'connected',
      ollama: 'unreachable',
      model: 'test-model',
    });
  }, 30_000);

  it('reports unavailable again after the agent stops', async () => {
    await stopAgent();
    const { body } = await getHealth();
    expect(ApiHealthSchema.parse(body).agent).toBe('unavailable');
  });

  it('answers unknown routes with 404 JSON', async () => {
    const response = await createApiApp({ agent: link, apiKey: API_KEY }).request('/nope', {
      headers: { 'x-api-key': API_KEY },
    });
    expect(response.status).toBe(404);
  });

  it('rejects a ticket list without an API key', async () => {
    const response = await createApiApp({ agent: link, apiKey: API_KEY }).request('/v1/tickets');
    expect(response.status).toBe(401);
  });
});

describe('department routes', () => {
  beforeAll(startAgent, 30_000);
  afterAll(stopAgent);

  const call = (path: string, init: RequestInit = {}) =>
    createApiApp({ agent: link, apiKey: API_KEY, log: () => undefined }).request(path, {
      ...init,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
    });

  it('PATCH edits name, description, and active, and keeps the id', async () => {
    await call('/v1/departments', {
      method: 'POST',
      body: JSON.stringify({ id: 'hr', name: 'HR', description: 'People' }),
    });
    const patched = await call('/v1/departments/hr', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'People Ops', active: false }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      id: 'hr',
      name: 'People Ops',
      description: 'People',
      active: false,
      aliases: [],
      examples: [],
    });

    const aliased = await call('/v1/departments/hr', {
      method: 'PATCH',
      body: JSON.stringify({ aliases: ['People team'], examples: ['I need a new contract'] }),
    });
    expect(await aliased.json()).toMatchObject({ id: 'hr', aliases: ['People team'], examples: ['I need a new contract'] });
    const taken = await call('/v1/departments', {
      method: 'POST',
      body: JSON.stringify({ id: 'ops', name: 'Ops', description: '', aliases: ['people TEAM'] }),
    });
    expect(taken.status).toBe(409);

    const renamed = await call('/v1/departments/hr', { method: 'PATCH', body: JSON.stringify({ id: 'people' }) });
    expect(renamed.status).toBe(400);
  }, 30_000);

  it('DELETE removes an unused department and refuses one a decision references', async () => {
    await call('/v1/departments', {
      method: 'POST',
      body: JSON.stringify({ id: 'spare', name: 'Spare', description: '' }),
    });
    expect((await call('/v1/departments/spare', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/departments/spare', { method: 'DELETE' })).status).toBe(404);

    await call('/v1/departments', {
      method: 'POST',
      body: JSON.stringify({ id: 'billing', name: 'Billing', description: 'Invoices' }),
    });
    const classified = await call('/v1/tickets:classify', {
      method: 'POST',
      body: JSON.stringify({ externalId: 'api-1', subject: 'Invoice', body: 'Pay', channel: 'email' }),
    });
    const ticket = (await classified.json()) as { id: string };
    await call(`/v1/tickets/${ticket.id}/override`, {
      method: 'POST',
      body: JSON.stringify({ departmentId: 'billing' }),
    });
    const refused = await call('/v1/departments/billing', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Deactivate it instead/);
  }, 60_000);

  it('has no settings or token route', async () => {
    for (const path of ['/v1/settings', '/v1/settings/token']) {
      expect((await call(path, { method: 'POST', body: '{"token":"x"}' })).status).toBe(404);
    }
  });
});

describe('sender email over HTTP', () => {
  beforeAll(startAgent, 30_000);
  afterAll(stopAgent);

  const call = (path: string, body: unknown) =>
    createApiApp({ agent: link, apiKey: API_KEY, log: () => undefined }).request(path, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('accepts an optional email, rejects a value that is not one address, and merges', async () => {
    const ok = await call('/v1/tickets:classify', {
      externalId: 'mail-1',
      subject: 'Invoice',
      body: 'x',
      channel: 'email',
      email: ' Ann@Example.com ',
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { email: string }).email).toBe('ann@example.com');

    for (const email of ['not-an-email', 'a@b.com, c@d.com', 'Ann <ann@example.com>']) {
      const bad = await call('/v1/tickets:classify', { externalId: 'mail-2', subject: 's', body: '', channel: 'api', email });
      expect(bad.status, email).toBe(400);
    }

    const merged = await call('/v1/senders:merge', { from: 'ann@example.com', into: 'ann.new@example.com' });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ email: 'ann.new@example.com', movedTickets: 1 });
    expect((await call('/v1/senders:merge', { from: 'ann@example.com', into: 'x@example.com' })).status).toBe(404);
    expect((await call('/v1/senders:merge', { from: 'a@example.com', into: 'A@example.com' })).status).toBe(400);
  }, 60_000);

  it('exports override feedback read only, with the API key, and without an email', async () => {
    const app = createApiApp({ agent: link, apiKey: API_KEY, log: () => undefined });
    expect((await app.request('/v1/tickets:override-feedback')).status).toBe(401);
    const response = await app.request('/v1/tickets:override-feedback', { headers: { 'x-api-key': API_KEY } });
    expect(response.status).toBe(200);
    const text = await response.text();
    const feedback = OverrideFeedbackSchema.parse(JSON.parse(text));
    // No model is reachable here, so no classifier department was ever replaced.
    expect(feedback.items).toEqual([]);
    expect(text).not.toContain('@example.com');
  }, 30_000);
});

describe('category and priority routes', () => {
  beforeAll(startAgent, 30_000);
  afterAll(stopAgent);

  const call = (path: string, init: RequestInit = {}) =>
    createApiApp({ agent: link, apiKey: API_KEY, log: () => undefined }).request(path, {
      ...init,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
    });
  const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });

  it('creates, lists, edits, and deletes categories; the id is fixed and a stored category cannot be deleted', async () => {
    expect((await createApiApp({ agent: link, apiKey: API_KEY }).request('/v1/categories')).status).toBe(401);
    expect((await post('/v1/categories', { id: 'outage', name: 'Outage', description: '' })).status).toBe(400);
    const created = await post('/v1/categories', { id: 'outage', name: 'Outage', description: 'Down', defaultPriority: 'urgent' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      id: 'outage',
      name: 'Outage',
      description: 'Down',
      active: true,
      defaultPriority: 'urgent',
      examples: [],
    });
    expect((await post('/v1/categories', { id: 'outage', name: 'Again', description: '', defaultPriority: 'low' })).status).toBe(409);
    const patched = await call('/v1/categories/outage', { method: 'PATCH', body: JSON.stringify({ examples: ['Site down'] }) });
    expect(((await patched.json()) as { examples: string[] }).examples).toEqual(['Site down']);
    expect((await call('/v1/categories/outage', { method: 'PATCH', body: JSON.stringify({ id: 'x' }) })).status).toBe(400);
    expect((await call('/v1/categories/nope', { method: 'PATCH', body: JSON.stringify({ active: false }) })).status).toBe(404);

    await post('/v1/categories', { id: 'how-to', name: 'How-to', description: '', defaultPriority: 'low' });
    const listed = (await (await call('/v1/categories')).json()) as { id: string }[];
    expect(listed.map((c) => c.id)).toEqual(['how-to', 'outage']);

    // No model is reachable here: the decision is failed, with no category and no priority.
    const classified = await post('/v1/tickets:classify', { externalId: 'cat-1', subject: 'Site down', body: 'x', channel: 'web' });
    const ticket = (await classified.json()) as { id: string; decision: Record<string, unknown> };
    expect(ticket.decision).toMatchObject({ status: 'failed', categoryId: null, priority: null, priorityReviewed: false });

    const categorized = await post(`/v1/tickets/${ticket.id}/category`, { categoryId: 'outage' });
    expect(categorized.status).toBe(200);
    expect(((await categorized.json()) as { decision: unknown }).decision).toMatchObject({
      status: 'failed',
      departmentId: null,
      categoryId: 'outage',
      replacedCategoryId: null,
      categoryReviewed: true,
      priority: null,
    });
    const prioritized = await post(`/v1/tickets/${ticket.id}/priority`, { priority: 'urgent' });
    expect(((await prioritized.json()) as { decision: unknown }).decision).toMatchObject({
      categoryId: 'outage',
      priority: 'urgent',
      replacedPriority: null,
      priorityReviewed: true,
    });
    expect((await post(`/v1/tickets/${ticket.id}/priority`, { priority: 'critical' })).status).toBe(400);
    expect((await post(`/v1/tickets/${ticket.id}/category`, { categoryId: 'unknown' })).status).toBe(400);
    expect((await post('/v1/tickets/00000000-0000-4000-8000-00000000dead/priority', { priority: 'low' })).status).toBe(404);

    await call('/v1/categories/how-to', { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const inactive = await post(`/v1/tickets/${ticket.id}/category`, { categoryId: 'how-to' });
    expect(inactive.status).toBe(400);
    expect(((await inactive.json()) as { error: { message: string } }).error.message).toMatch(/not active/);

    const refused = await call('/v1/categories/outage', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect((await call('/v1/categories/how-to', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/categories/how-to', { method: 'DELETE' })).status).toBe(404);
  }, 60_000);
});
