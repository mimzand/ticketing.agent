import { openTicketDatabase, type TicketDatabase } from '@ticket/storage';
import { DEPARTMENT_IN_USE_MESSAGE } from '@ticket/shared';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostOptions } from './host.js';

let server: Server | undefined;
let db: TicketDatabase | undefined;
let dir: string | undefined;
let chatCalls = 0;
/** Chat requests the client hung up on before an answer (a cancel reached Ollama). */
let hungUpChats = 0;
/** Request bodies and headers the fake Ollama received. */
let seen: {
  path: string;
  model: string | undefined;
  headers: IncomingHttpHeaders;
  system: string;
  user: string;
}[] = [];

afterEach(async () => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  const current = server;
  server = undefined;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

const json = (value: unknown) => JSON.stringify(value);
const DEAD_URL = 'http://127.0.0.1:1';

/** A fake Ollama: `/api/chat` answers `reply()`, `/api/tags` lists two models. */
async function fakeOllama(reply: () => unknown): Promise<string> {
  chatCalls = 0;
  hungUpChats = 0;
  seen = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text
        ? (JSON.parse(text) as { model?: string; messages?: { role: string; content: string }[] })
        : {};
      const message = (role: string) => body.messages?.find((m) => m.role === role)?.content ?? '';
      seen.push({
        path: req.url ?? '',
        model: body.model,
        headers: req.headers,
        system: message('system'),
        user: message('user'),
      });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(json({ models: [{ name: 'test-model', size: 1 }, { name: 'saved-model', size: 2 }] }));
        return;
      }
      chatCalls += 1;
      const answer = reply();
      if (answer === 'hang') {
        res.on('close', () => {
          if (!res.writableEnded) hungUpChats += 1;
        });
        return;
      }
      if (answer === 'down') {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ message: { role: 'assistant', content: json(answer) } }));
    });
  });
  return new Promise<string>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (address && typeof address !== 'string') resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function hostWith(env: NodeJS.ProcessEnv, extra: Partial<AgentHostOptions> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'ticket-host-'));
  const databasePath = join(dir, 'tickets.db');
  db = openTicketDatabase(databasePath);
  db.insertDepartment({ id: 'billing', name: 'Billing', description: 'Invoices' });
  return createAgentHost({ db, env, databasePath, ...extra });
}

const hostFor = (baseUrl: string) => hostWith({ OLLAMA_HOST: baseUrl, OLLAMA_MODEL: 'test-model' });

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
    const firstCalls = chatCalls;
    const again = await host.classify({ ...ticket, subject: 'Different subject' });
    expect(again.subject).toBe('Invoice 18');
    expect(chatCalls).toBe(firstCalls);
  }, 30_000);

  it('does not offer an inactive department to the classifier', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.95, rationale: 'Invoice.' })));
    host.updateDepartment({ id: 'billing', active: false });
    const view = await host.classify(ticket);
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null });
  }, 30_000);
});

describe('departments', () => {
  it('an edit changes name, description, and active, and keeps the id', () => {
    const host = hostWith({});
    const updated = host.updateDepartment({
      id: 'billing',
      name: 'Accounts',
      description: 'Invoices and refunds',
      active: false,
    });
    expect(updated).toEqual({
      id: 'billing',
      name: 'Accounts',
      description: 'Invoices and refunds',
      active: false,
      aliases: [],
      examples: [],
    });
    // The edit is a new taxonomy version (1 was the create).
    expect(host.taxonomy().current).toBe(2);
    expect(host.listDepartments()).toEqual([updated]);
  });

  it('an inactive department stays listed and cannot be an override target', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.2, rationale: 'Unsure.' })));
    const view = await host.classify(ticket);
    host.updateDepartment({ id: 'billing', active: false });
    expect(host.listDepartments().map((d) => d.id)).toEqual(['billing']);
    expect(() => host.override({ id: view.id, departmentId: 'billing' })).toThrow('not active');
  }, 30_000);

  it('removes a department that no decision references', () => {
    const host = hostWith({});
    host.createDepartment({ id: 'spare', name: 'Spare', description: '' });
    expect(host.deleteDepartment({ id: 'spare' })).toEqual({ id: 'spare', deleted: true });
    expect(host.listDepartments().map((d) => d.id)).toEqual(['billing']);
  });

  it('refuses to remove a department a decision references, and changes no ticket', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.91, rationale: 'Invoice.' })));
    const view = await host.classify(ticket);
    let error: unknown;
    try {
      host.deleteDepartment({ id: 'billing' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'HostError', code: 'conflict', message: DEPARTMENT_IN_USE_MESSAGE });
    expect(DEPARTMENT_IN_USE_MESSAGE).toMatch(/Deactivate it instead/);
    expect(host.listDepartments().map((d) => d.id)).toEqual(['billing']);
    expect(host.listTickets()).toEqual([view]);
  }, 30_000);
});

describe('settings', () => {
  it('a saved setting is what the next classify uses, without a restart', async () => {
    const url = await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' }));
    const host = hostWith({});
    // Defaults: a server that is not there.
    host.updateSettings({ ollamaBaseUrl: DEAD_URL, connectTimeoutMs: 500 });
    expect((await host.classify(ticket)).decision.status).toBe('failed');

    host.updateSettings({ ollamaBaseUrl: url, model: 'saved-model', minConfidence: 0.95 });
    const next = await host.classify({ ...ticket, externalId: 'ext-2' });
    expect(seen.filter((r) => r.path === '/api/chat').map((r) => r.model)).toEqual(['saved-model']);
    // 0.9 is below the saved 0.95 threshold.
    expect(next.decision).toMatchObject({ status: 'needs_review', departmentId: null, confidence: 0.9 });

    expect(host.getSettings().fields.model).toMatchObject({ value: 'saved-model', source: 'saved' });
  }, 30_000);

  it('does not save an invalid value', () => {
    const host = hostWith({});
    expect(() => host.updateSettings({ ollamaBaseUrl: 'ftp://example.com' })).toThrow();
    expect(() => host.updateSettings({ ollamaBaseUrl: 'http://user:pw@example.com' })).toThrow();
    expect(() => host.updateSettings({ minConfidence: 1.5 })).toThrow();
    expect(host.getSettings().fields.ollamaBaseUrl.source).toBe('default');
    expect(host.getSettings().fields.minConfidence).toMatchObject({ value: 0.7, source: 'default', saved: null });
  });

  it('a valid OLLAMA_HOST overrides the saved value and cannot be saved over', () => {
    const host = hostWith({ OLLAMA_HOST: 'http://ollama.internal:11434' });
    const field = host.getSettings().fields.ollamaBaseUrl;
    expect(field).toMatchObject({
      value: 'http://ollama.internal:11434',
      source: 'env',
      envVar: 'OLLAMA_HOST',
      envError: null,
    });
    expect(() => host.updateSettings({ ollamaBaseUrl: 'http://other:11434' })).toThrow(/OLLAMA_HOST/);
  });

  it('an invalid variable is not applied and the error is on the field', () => {
    const host = hostWith({
      OLLAMA_HOST: 'ftp://secret:pw@host',
      CLASSIFY_MIN_CONFIDENCE: 'high',
    });
    const { ollamaBaseUrl, minConfidence } = host.getSettings().fields;
    expect(ollamaBaseUrl).toMatchObject({ source: 'default', value: 'http://127.0.0.1:11434', envVar: 'OLLAMA_HOST' });
    expect(ollamaBaseUrl.envError).toMatch(/OLLAMA_HOST is set but not applied/);
    expect(ollamaBaseUrl.envError).not.toContain('secret');
    expect(minConfidence.envError).toMatch(/CLASSIFY_MIN_CONFIDENCE/);
    expect(minConfidence.value).toBe(0.7);
    // Not overridden, so it can still be saved.
    host.updateSettings({ minConfidence: 0.8 });
    expect(host.getSettings().fields.minConfidence).toMatchObject({ value: 0.8, source: 'saved' });
  });

  it('keeps the token in memory, reports only whether it is set, and sends it only to loopback or https', async () => {
    const url = await fakeOllama(() => ({}));
    const host = hostWith({});
    const token = 'tok_' + 'x'.repeat(40);
    expect(host.setToken(token)).toEqual({ tokenSet: true });
    const view = host.getSettings();
    expect(view.tokenSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain(token);

    const result = await host.testConnection({ baseUrl: url });
    expect(result).toMatchObject({ ok: true, modelCount: 2, tokenSent: true });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    // Test connection does not save the URL.
    expect(host.getSettings().fields.ollamaBaseUrl.source).toBe('default');

    const remote = await host.testConnection({ baseUrl: 'http://192.0.2.1:11434', timeoutMs: 500 });
    expect(remote).toMatchObject({ ok: false, tokenSent: false });
    expect(JSON.stringify(remote)).not.toContain(token);

    expect(host.setToken(null)).toEqual({ tokenSet: false });
  }, 30_000);

  it('lists the models of the effective server and reports storage counts', async () => {
    const url = await fakeOllama(() => ({}));
    const host = hostWith({ OLLAMA_HOST: url });
    const models = await host.listModels();
    expect(models).toMatchObject({ reachable: true, server: url });
    expect(models.models.map((m) => m.name)).toEqual(['test-model', 'saved-model']);
    const info = host.storageInfo();
    expect(info).toMatchObject({ departmentCount: 1, ticketCount: 0 });
    expect(info.databasePath).toMatch(/tickets\.db$/);
  }, 30_000);
});

describe('interrupted classifies', () => {
  it('reclassifies a ticket row that has no decision (a crash) instead of failing the unique externalId', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.91, rationale: 'Invoice.' })));
    // What a crash between the ticket insert and the decision leaves behind.
    if (!db) throw new Error('no db');
    db.insertTicket({ ...ticket, subject: 'Old text' });
    expect(host.listTickets()).toEqual([]);
    const view = await host.classify(ticket);
    expect(view).toMatchObject({ subject: 'Invoice 18', decision: { status: 'labeled', departmentId: 'billing' } });
    expect(host.listTickets()).toHaveLength(1);
    expect(host.storageInfo().ticketCount).toBe(1);
  }, 30_000);

  it('a cancel aborts the Ollama request, stores nothing, and frees the externalId', async () => {
    let mode: 'hang' | 'answer' = 'hang';
    const host = hostFor(
      await fakeOllama(() => (mode === 'hang' ? 'hang' : { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' })),
    );
    const controller = new AbortController();
    const pending = host.classify(ticket, controller.signal).catch((error: unknown) => error);
    await waitUntil(() => chatCalls === 1);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'HostError', code: 'cancelled' });
    await waitUntil(() => hungUpChats === 1);
    expect(host.listTickets()).toEqual([]);
    expect(host.storageInfo().ticketCount).toBe(0);

    mode = 'answer';
    const again = await host.classify(ticket);
    expect(again.decision.status).toBe('labeled');
  }, 30_000);

  it('a cancel after the decision is stored does not undo it', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' })));
    const controller = new AbortController();
    const view = await host.classify(ticket, controller.signal);
    controller.abort();
    expect(host.listTickets()).toEqual([view]);
    // And a cancelled resubmit of a decided externalId still returns the stored decision.
    const late = new AbortController();
    late.abort();
    expect((await host.classify(ticket, late.signal)).id).toBe(view.id);
  }, 30_000);
});

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out.');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('aliases, examples, quote, and taxonomy versions', () => {
  const invoiceTicket = {
    externalId: 'q-1',
    subject: 'Invoice 18 is wrong',
    body: 'The total on invoice 18 is twice the agreed price.',
    channel: 'email',
  };

  it('the instruction lists aliases and examples; the ticket stays in the user message', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' })));
    host.updateDepartment({ id: 'billing', aliases: ['Accounts payable'], examples: ['My invoice total is wrong'] });
    await host.classify(invoiceTicket);
    const chat = seen.find((r) => r.path === '/api/chat');
    expect(chat?.system).toContain('"Accounts payable"');
    expect(chat?.system).toContain('"My invoice total is wrong"');
    expect(chat?.system).not.toContain('twice the agreed price');
    expect(chat?.user).toContain('twice the agreed price');
  }, 30_000);

  it('stores a quote that is an exact substring of the ticket', async () => {
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'twice the agreed price' })),
    );
    const view = await host.classify(invoiceTicket);
    expect(view.decision).toMatchObject({ status: 'labeled', departmentId: 'billing', quote: 'twice the agreed price' });
    expect(host.listTickets()[0]?.decision.quote).toBe('twice the agreed price');
  }, 30_000);

  it('stores null for a quote that is not in the ticket, without asking the model again', async () => {
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'three times the price' })),
    );
    const view = await host.classify(invoiceTicket);
    expect(view.decision.quote).toBeNull();
    expect(chatCalls).toBe(1);
  }, 30_000);

  it('stores null for a quote longer than 240 characters even if it is in the ticket', async () => {
    const long = 'x'.repeat(241);
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: long })),
    );
    const view = await host.classify({ ...invoiceTicket, body: long });
    expect(view.decision.quote).toBeNull();
  }, 30_000);

  it('needs_review still has a null department, with or without a quote', async () => {
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.3, rationale: 'Unsure.', quote: 'Invoice 18' })),
    );
    const view = await host.classify(invoiceTicket);
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null, quote: 'Invoice 18' });
  }, 30_000);

  it('an alias is not an id', async () => {
    const host = hostFor(await fakeOllama(() => ({ departmentId: 'Accounts payable', confidence: 0.99, rationale: 'Alias.' })));
    host.updateDepartment({ id: 'billing', aliases: ['Accounts payable'] });
    const view = await host.classify(invoiceTicket);
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null });
  }, 30_000);

  it('a department edit increments the version and the decision stores the version it used', async () => {
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' })),
    );
    expect(host.taxonomy().current).toBe(1); // hostWith created billing
    const first = await host.classify(invoiceTicket);
    expect(first.decision.taxonomyVersion).toBe(1);

    host.updateDepartment({ id: 'billing', examples: ['Refund my order'] });
    expect(host.taxonomy().current).toBe(2);
    const second = await host.classify({ ...invoiceTicket, externalId: 'q-2' });
    expect(second.decision.taxonomyVersion).toBe(2);
    // Old decisions are not rewritten.
    expect(host.listTickets().find((t) => t.externalId === 'q-1')?.decision.taxonomyVersion).toBe(1);
    expect(host.taxonomy().history.map((v) => v.version)).toEqual([2, 1]);
  }, 30_000);

  it('a repeated externalId returns the stored quote and does not call the model', async () => {
    const host = hostFor(
      await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' })),
    );
    const first = await host.classify(invoiceTicket);
    const calls = chatCalls;
    host.updateDepartment({ id: 'billing', name: 'Accounts' });
    const again = await host.classify({ ...invoiceTicket, subject: 'Something else' });
    expect(chatCalls).toBe(calls);
    expect(again.decision).toEqual(first.decision);
  }, 30_000);

  it('with no department the version stays 0 and classify does not invent one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-host-'));
    db = openTicketDatabase(join(dir, 'tickets.db'));
    const url = await fakeOllama(() => ({ departmentId: 'billing', confidence: 0.9, rationale: 'Guess.' }));
    const host = createAgentHost({ db, env: { OLLAMA_HOST: url, OLLAMA_MODEL: 'test-model' } });
    const view = await host.classify(invoiceTicket);
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null, taxonomyVersion: 0 });
    expect(host.taxonomy()).toEqual({ current: 0, history: [] });
  }, 30_000);

  it('refuses an alias another department already has, and limits the lists', () => {
    const host = hostWith({});
    host.updateDepartment({ id: 'billing', aliases: ['Invoices'] });
    expect(() => host.createDepartment({ id: 'finance', name: 'Finance', description: '', aliases: ['invoices'] })).toThrow(
      /already belongs to the department billing/,
    );
    expect(() =>
      host.createDepartment({
        id: 'finance',
        name: 'Finance',
        description: '',
        aliases: Array.from({ length: 21 }, (_, i) => `a${i}`),
      }),
    ).toThrow(/At most 20 aliases/);
    expect(host.taxonomy().current).toBe(2);
  });
});
