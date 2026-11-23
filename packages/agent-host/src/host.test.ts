import { createOllamaClient, type OllamaClient } from '@ticket/model-provider';
import { openTicketDatabase, type TicketDatabase } from '@ticket/storage';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost } from './host.js';

let server: Server | undefined;
let db: TicketDatabase | undefined;
let dir: string | undefined;
let calls = 0;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

function content(value: unknown): string {
  return JSON.stringify(value);
}

async function fakeOllama(reply: () => unknown | 'down'): Promise<OllamaClient> {
  calls = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      calls += 1;
      const answer = reply();
      if (answer === 'down') {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(content({ message: { role: 'assistant', content: content(answer) } }));
    });
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (address && typeof address !== 'string') resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return createOllamaClient({ baseUrl, model: 'test-model', token: undefined, timeoutMs: 2_000 });
}

function hostFor(ollama: OllamaClient) {
  dir = mkdtempSync(join(tmpdir(), 'ticket-host-'));
  db = openTicketDatabase(join(dir, 'tickets.db'));
  db.insertDepartment({ id: 'billing', name: 'Billing', description: 'Invoices' });
  return createAgentHost({ db, ollama, minConfidence: 0.7 });
}

const ticket = {
  externalId: 'ext-1',
  subject: 'Invoice 18',
  body: 'Please look at this invoice.',
  channel: 'email',
};

describe('createAgentHost classify', () => {
  it('labels an active department when confidence is high enough', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.91, rationale: 'Invoice.' })));
    const view = await host.classify(ticket);
    expect(view.decision).toMatchObject({ status: 'labeled', departmentId: 'billing', confidence: 0.91 });
  }, 30_000);

  it('does not apply an unknown department', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'other', confidence: 0.99, rationale: 'Guess.' })));
    const view = await host.classify(ticket);
    expect(view.decision.status).toBe('needs_review');
    expect(view.decision.departmentId).toBeNull();
  }, 30_000);

  it('does not apply a low-confidence label', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.4, rationale: 'Unsure.' })));
    const view = await host.classify(ticket);
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null });
  }, 30_000);

  it('records failed when Ollama is down', async () => {
    const host = hostFor(await fakeOllama(() => 'down'));
    const view = await host.classify(ticket);
    expect(view.decision.status).toBe('failed');
    expect(view.decision.departmentId).toBeNull();
  }, 30_000);

  it('returns the stored decision for a repeated externalId without a second model call', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' })));
    await host.classify(ticket);
    const firstCalls = calls;
    const again = await host.classify({ ...ticket, subject: 'Different subject' });
    expect(again.subject).toBe('Invoice 18');
    expect(calls).toBe(firstCalls);
  }, 30_000);
});
