import { createAgentLink, type AgentLink } from '@ticket/agent-client';
import { ApiHealthSchema } from '@ticket/shared';
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
