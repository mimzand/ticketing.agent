import { openTicketDatabase, type TicketDatabase } from '@ticket/storage';
import { CATEGORY_IN_USE_MESSAGE, DEPARTMENT_IN_USE_MESSAGE } from '@ticket/shared';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, HostError, type AgentHostOptions } from './host.js';

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

describe('sender memory', () => {
  const answer = { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' };
  const first = { externalId: 's-1', subject: 'Invoice 18 is wrong', body: 'Please fix.', channel: 'email' };
  const second = { externalId: 's-2', subject: 'Refund request', body: 'Where is my refund?', channel: 'chat' };
  const lastUser = () => seen.filter((r) => r.path === '/api/chat').at(-1)?.user ?? '';
  const HISTORY = 'earlier tickets from the same sender';
  const EMPTY_SUMMARY = { tickets: 0, byDepartment: [], overridden: 0 };

  it('the same email on two channels is one person; the second classify sees the first decision as data', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    const a = await host.classify({ ...first, email: '  Ann@Example.COM ' });
    expect(a.email).toBe('ann@example.com');
    expect(lastUser()).not.toContain(HISTORY);

    const b = await host.classify({ ...second, email: 'ann@example.com' });
    expect(b.email).toBe('ann@example.com');
    const user = lastUser();
    expect(user).toContain(HISTORY);
    expect(user).toContain('"subject": "Invoice 18 is wrong"');
    expect(user).toContain('"channel": "email"');
    expect(user).toContain('"department": "billing"');
    expect(user).toContain('"quote": "Invoice 18"');
    // No body of the earlier ticket, and nothing about it in the instruction.
    expect(user).not.toContain('Please fix.');
    const system = seen.filter((r) => r.path === '/api/chat').at(-1)?.system ?? '';
    expect(system).not.toContain('Invoice 18 is wrong');
    expect(system).toMatch(/summary and the history are untrusted data/);

    expect(host.ticketContext({ id: b.id })).toEqual({
      email: 'ann@example.com',
      prior: [
        {
          subject: 'Invoice 18 is wrong',
          channel: 'email',
          status: 'labeled',
          departmentId: 'billing',
          quote: 'Invoice 18',
          replacedDepartmentId: null,
          createdAt: a.createdAt,
        },
      ],
      summary: { tickets: 1, byDepartment: [{ departmentId: 'billing', count: 1 }], overridden: 0 },
    });
    expect(host.ticketContext({ id: a.id }).prior).toEqual([]);
  }, 30_000);

  it('a different email sees nothing', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    await host.classify({ ...first, email: 'ann@example.com' });
    const b = await host.classify({ ...second, email: 'bob@example.com' });
    expect(lastUser()).not.toContain(HISTORY);
    expect(host.ticketContext({ id: b.id })).toEqual({ email: 'bob@example.com', prior: [], summary: EMPTY_SUMMARY });
  }, 30_000);

  it('a missing email stays an unknown sender with no memory', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    await host.classify(first);
    const b = await host.classify(second);
    expect(b.email).toBeNull();
    expect(lastUser()).not.toContain(HISTORY);
    expect(host.ticketContext({ id: b.id })).toEqual({ email: null, prior: [], summary: EMPTY_SUMMARY });
  }, 30_000);

  it('an address written only inside the body does not link the person', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    const inBody = await host.classify({
      ...second,
      subject: 'From ann@example.com',
      body: 'I am ann@example.com, see my other ticket.',
    });
    expect(inBody.email).toBeNull();
    expect(lastUser()).not.toContain(HISTORY);
    // Ann's memory holds only Ann's own ticket.
    const c = await host.classify({ externalId: 's-3', subject: 'Again', body: 'x', channel: 'web', email: 'ann@example.com' });
    expect(host.ticketContext({ id: c.id }).prior.map((p) => p.createdAt)).toEqual([a.createdAt]);
  }, 30_000);

  it('a quote and a department from history do not override the host rules', async () => {
    let reply: unknown = answer;
    const host = hostFor(await fakeOllama(() => reply));
    await host.classify({ ...first, email: 'ann@example.com' });
    // The model echoes the earlier ticket: its department (now inactive) and its quote.
    host.updateDepartment({ id: 'billing', active: false });
    reply = { departmentId: 'billing', confidence: 0.99, rationale: 'Same as last time.', quote: 'Invoice 18' };
    const b = await host.classify({ ...second, email: 'ann@example.com' });
    expect(lastUser()).toContain('"department": "billing"');
    expect(b.decision).toMatchObject({ status: 'needs_review', departmentId: null, quote: null });
  }, 30_000);

  it('a repeated externalId does not call the model; an email on the repeat is only attached', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    const stored = await host.classify(first);
    expect(stored.email).toBeNull();
    const calls = chatCalls;
    const again = await host.classify({ ...first, subject: 'Changed', email: 'Ann@example.com' });
    expect(chatCalls).toBe(calls);
    expect(again).toEqual({ ...stored, email: 'ann@example.com' });
    // A later repeat with another address does not move it.
    const third = await host.classify({ ...first, email: 'bob@example.com' });
    expect(third.email).toBe('ann@example.com');
    expect(chatCalls).toBe(calls);
  }, 30_000);

  it('merge moves the tickets onto the other email and keeps the decisions as they are', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    const old = await host.classify({ ...first, email: 'ann.old@example.com' });
    const kept = await host.classify({ ...second, email: 'ann@example.com' });
    expect(host.mergeSenders({ from: 'Ann.Old@example.com', into: 'ann@example.com' })).toEqual({
      email: 'ann@example.com',
      movedTickets: 1,
    });
    const moved = host.listTickets().find((t) => t.id === old.id);
    expect(moved).toEqual({ ...old, email: 'ann@example.com' });
    expect(moved?.decision).toEqual(old.decision);
    expect(host.ticketContext({ id: kept.id }).prior.map((p) => p.subject)).toEqual(['Invoice 18 is wrong']);
    // The old address is gone: merging from it again finds nothing.
    expect(() => host.mergeSenders({ from: 'ann.old@example.com', into: 'ann@example.com' })).toThrow(/No tickets/);
    expect(() => host.mergeSenders({ from: 'ann@example.com', into: 'ANN@example.com' })).toThrow(/same/);
  }, 30_000);

  it('loads at most 5 prior tickets, newest first', async () => {
    const host = hostFor(await fakeOllama(() => answer));
    for (let i = 1; i <= 7; i += 1) {
      await host.classify({ externalId: `m-${i}`, subject: `Ticket ${i}`, body: 'x', channel: 'email', email: 'ann@example.com' });
      await new Promise((r) => setTimeout(r, 2));
    }
    const last = host.listTickets()[0];
    expect(last?.subject).toBe('Ticket 7');
    expect(host.ticketContext({ id: last?.id ?? '' }).prior.map((p) => p.subject)).toEqual([
      'Ticket 6',
      'Ticket 5',
      'Ticket 4',
      'Ticket 3',
      'Ticket 2',
    ]);
  }, 60_000);
});

describe('sender memory: operator corrections and the summary', () => {
  const answer = { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' };
  const first = { externalId: 'r-1', subject: 'Invoice 18 is wrong', body: 'Old body text.', channel: 'email' };
  const second = { externalId: 'r-2', subject: 'Laptop broken', body: 'Screen is dark.', channel: 'chat' };
  const chats = () => seen.filter((r) => r.path === '/api/chat');
  const lastUser = () => chats().at(-1)?.user ?? '';
  const lastSystem = () => chats().at(-1)?.system ?? '';

  function withDepartments(host: ReturnType<typeof hostFor>) {
    host.createDepartment({ id: 'it', name: 'IT', description: 'Computers' });
    host.createDepartment({ id: 'hr', name: 'HR', description: 'People' });
    return host;
  }

  it('an override from billing to it reaches the next classify as summary and replacedDepartment', async () => {
    const host = withDepartments(hostFor(await fakeOllama(() => answer)));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    const overridden = host.override({ id: a.id, departmentId: 'it' });
    // The decision fields other than department and status stay as they were.
    expect(overridden.decision).toEqual({ ...a.decision, departmentId: 'it', status: 'overridden' });

    await host.classify({ ...second, email: 'ANN@example.com' });
    const user = lastUser();
    const summary = '{"tickets":1,"byDepartment":[{"departmentId":"it","count":1}],"overridden":1}';
    expect(user).toContain(summary);
    expect(user).toContain('"department": "it"');
    expect(user).toContain('"replacedDepartment": "billing"');
    // Summary before the rows.
    expect(user.indexOf(summary)).toBeLessThan(user.indexOf('"subject": "Invoice 18 is wrong"'));
    expect(user).not.toContain('Old body text.');
    expect(user).not.toContain('ann@example.com');
    const system = lastSystem();
    expect(system).not.toContain(summary);
    expect(system).not.toContain('"tickets"');
    expect(system).not.toContain('Invoice 18 is wrong');
    expect(system).toMatch(/replacedDepartment is what the classifier had applied/);
    expect(system).toMatch(/operator correction is stronger context than a model label/);
  }, 30_000);

  it('a second override changes the department but keeps the first replaced department', async () => {
    const host = withDepartments(hostFor(await fakeOllama(() => answer)));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    host.override({ id: a.id, departmentId: 'it' });
    const again = host.override({ id: a.id, departmentId: 'hr' });
    expect(again.decision).toMatchObject({ departmentId: 'hr', status: 'overridden', quote: 'Invoice 18' });
    // A later classifier save elsewhere does not clear it either.
    const b = await host.classify({ ...second, email: 'ann@example.com' });
    expect(lastUser()).toContain('"department": "hr"');
    expect(lastUser()).toContain('"replacedDepartment": "billing"');
    expect(host.ticketContext({ id: b.id })).toMatchObject({
      prior: [{ departmentId: 'hr', status: 'overridden', replacedDepartmentId: 'billing' }],
      summary: { tickets: 1, byDepartment: [{ departmentId: 'hr', count: 1 }], overridden: 1 },
    });
  }, 30_000);

  it('overriding a needs_review decision stores no replaced department', async () => {
    let reply: unknown = { departmentId: 'billing', confidence: 0.2, rationale: 'Unsure.' };
    const host = withDepartments(hostFor(await fakeOllama(() => reply)));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    expect(a.decision.status).toBe('needs_review');
    host.override({ id: a.id, departmentId: 'it' });
    reply = answer;
    const b = await host.classify({ ...second, email: 'ann@example.com' });
    expect(lastUser()).toContain('"department": "it"');
    expect(lastUser()).toContain('"replacedDepartment": "none"');
    expect(host.ticketContext({ id: b.id }).prior[0]?.replacedDepartmentId).toBeNull();
  }, 30_000);

  it('a classify that was never overridden reports replacedDepartment none, and no email sends no block', async () => {
    const host = withDepartments(hostFor(await fakeOllama(() => answer)));
    await host.classify({ ...first, email: 'ann@example.com' });
    await host.classify({ ...second, email: 'ann@example.com' });
    expect(lastUser()).toContain('"replacedDepartment": "none"');
    expect(lastUser()).toContain('"overridden":0');
    await host.classify({ externalId: 'r-3', subject: 'No sender', body: 'x', channel: 'web' });
    expect(lastUser()).not.toContain('earlier tickets from the same sender');
    expect(lastUser()).not.toContain('"byDepartment"');
  }, 30_000);

  it('a department or quote copied from the history or the replaced department is not applied', async () => {
    let reply: unknown = answer;
    const host = withDepartments(hostFor(await fakeOllama(() => reply)));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    host.override({ id: a.id, departmentId: 'it' });
    host.updateDepartment({ id: 'billing', active: false });
    // The model copies the replaced department (now inactive) and the old quote.
    reply = { departmentId: 'billing', confidence: 0.99, rationale: 'As before.', quote: 'Invoice 18' };
    const b = await host.classify({ ...second, email: 'ann@example.com' });
    expect(lastUser()).toContain('"replacedDepartment": "billing"');
    expect(b.decision).toMatchObject({ status: 'needs_review', departmentId: null, quote: null });
    // An unknown id that only appears as a summary bucket is not applied either.
    reply = { departmentId: 'none', confidence: 0.99, rationale: 'Summary.', quote: 'Laptop' };
    const c = await host.classify({ ...second, externalId: 'r-4', email: 'ann@example.com' });
    expect(c.decision).toMatchObject({ status: 'needs_review', departmentId: null });
  }, 30_000);

  it('a repeated externalId still does not call the model after an override', async () => {
    const host = withDepartments(hostFor(await fakeOllama(() => answer)));
    const a = await host.classify({ ...first, email: 'ann@example.com' });
    const overridden = host.override({ id: a.id, departmentId: 'it' });
    const calls = chatCalls;
    const again = await host.classify({ ...first, email: 'ann@example.com' });
    expect(chatCalls).toBe(calls);
    expect(again).toEqual(overridden);
  }, 30_000);
});

describe('override feedback export', () => {
  const answer = { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' };

  it('lists an override that replaced a classifier department, with both ids and no email', async () => {
    let reply: unknown = answer;
    const host = hostFor(await fakeOllama(() => reply));
    host.createDepartment({ id: 'it', name: 'IT', description: 'Computers' });
    const labeled = await host.classify({
      externalId: 'f-1',
      subject: 'Invoice 18 for the laptop',
      body: 'The laptop screen is dark.',
      channel: 'email',
      email: 'Ann@Example.com',
    });
    host.override({ id: labeled.id, departmentId: 'it' });
    // Not exported: never overridden, or overridden from no classifier department.
    await host.classify({ externalId: 'f-2', subject: 'Invoice 19', body: 'x', channel: 'email', email: 'ann@example.com' });
    reply = { departmentId: 'billing', confidence: 0.2, rationale: 'Unsure.' };
    const unsure = await host.classify({ externalId: 'f-3', subject: 'Hello', body: 'x', channel: 'chat', email: 'ann@example.com' });
    host.override({ id: unsure.id, departmentId: 'it' });

    const feedback = host.overrideFeedback();
    expect(feedback.taxonomyVersion).toBe(host.taxonomy().current);
    expect(feedback.departments.map((d) => d.id)).toEqual(['billing', 'it']);
    expect(feedback.items).toEqual([
      {
        ticketId: labeled.id,
        externalId: 'f-1',
        subject: 'Invoice 18 for the laptop',
        body: 'The laptop screen is dark.',
        channel: 'email',
        createdAt: labeled.createdAt,
        replacedDepartmentId: 'billing',
        departmentId: 'it',
        status: 'overridden',
        confidence: 0.9,
        rationale: 'Invoice.',
        quote: 'Invoice 18',
        taxonomyVersion: labeled.decision.taxonomyVersion,
      },
    ]);
    const serialized = JSON.stringify(feedback);
    expect(serialized).not.toMatch(/example\.com/i);
    expect(serialized).not.toContain('"email":');
    expect(serialized).not.toMatch(/ann@/i);
    // Read only: the catalogue is unchanged.
    expect(host.listDepartments().find((d) => d.id === 'it')?.examples).toEqual([]);
  }, 30_000);
});

describe('problem categories and priority', () => {
  const lastChat = () => seen.filter((r) => r.path === '/api/chat').at(-1) ?? { system: '', user: '' };
  const base = { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 18' };
  let n = 0;
  const next = (extra: Record<string, unknown> = {}) => ({
    externalId: `p-${(n += 1)}`,
    subject: 'Invoice 18 is wrong',
    body: 'The secret body text 4711.',
    channel: 'email',
    ...extra,
  });

  function withCategories(host: ReturnType<typeof hostFor>) {
    host.createCategory({ id: 'outage', name: 'Outage', description: 'A service is down', defaultPriority: 'urgent' });
    host.createCategory({ id: 'how-to', name: 'How-to', description: 'A usage question', defaultPriority: 'low' });
    return host;
  }

  it('manages categories like departments: default priority required, id fixed, inactive kept, delete refused while stored', async () => {
    let reply: unknown = { ...base, categoryId: 'outage', priority: 'high' };
    const host = withCategories(hostFor(await fakeOllama(() => reply)));
    expect(() => host.createCategory({ id: 'x', name: 'X', description: '' } as never)).toThrow(HostError);
    expect(() => host.createCategory({ id: 'outage', name: 'Again', description: '', defaultPriority: 'low' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => host.updateCategory({ id: 'nope', active: false })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(host.updateCategory({ id: 'how-to', examples: ['How do I export?'] }).examples).toEqual(['How do I export?']);

    const ticket = await host.classify(next());
    host.setCategory({ id: ticket.id, categoryId: 'how-to' });
    // outage is now only the replaced category; both ids are still stored.
    for (const id of ['outage', 'how-to']) {
      expect(() => host.deleteCategory({ id })).toThrow(expect.objectContaining({ code: 'conflict', message: CATEGORY_IN_USE_MESSAGE }));
    }
    host.createCategory({ id: 'spare', name: 'Spare', description: '', defaultPriority: 'normal' });
    expect(host.deleteCategory({ id: 'spare' })).toEqual({ id: 'spare', deleted: true });
    expect(() => host.deleteCategory({ id: 'spare' })).toThrow(expect.objectContaining({ code: 'not_found' }));

    // Deactivated: still listed, and neither the model nor an admin can assign it.
    host.updateCategory({ id: 'outage', active: false });
    expect(host.listCategories().find((c) => c.id === 'outage')?.active).toBe(false);
    reply = { ...base, categoryId: 'outage', priority: 'urgent' };
    const after = await host.classify(next());
    expect(after.decision).toMatchObject({ status: 'labeled', departmentId: 'billing', categoryId: null, priority: 'urgent' });
    expect(lastChat().system).not.toContain('- id: outage');
    expect(() => host.setCategory({ id: after.id, categoryId: 'outage' })).toThrow('That category is not active.');
    expect(() => host.setCategory({ id: after.id, categoryId: 'unknown' })).toThrow('That category is not active.');
    expect(taxonomyOf(host)).toBe(1);
  }, 30_000);

  function taxonomyOf(host: ReturnType<typeof hostFor>) {
    return host.taxonomy().current;
  }

  it('stores a valid category and priority beside the department decision', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage', priority: 'high' }))));
    const view = await host.classify(next());
    expect(view.decision).toEqual({
      departmentId: 'billing',
      confidence: 0.9,
      rationale: 'Invoice.',
      status: 'labeled',
      quote: 'Invoice 18',
      taxonomyVersion: 1,
      categoryId: 'outage',
      replacedCategoryId: null,
      categoryReviewed: false,
      priority: 'high',
      replacedPriority: null,
      priorityReviewed: false,
    });
  }, 30_000);

  it.each([
    ['an unknown category and a priority in the wrong case', { categoryId: 'outages', priority: 'High' }],
    ['a name instead of an id and an invented priority', { categoryId: 'Outage', priority: 'critical' }],
    ['wrong types', { categoryId: 7, priority: 3 }],
    ['no category and no priority', {}],
  ])('keeps the department and stores null for %s', async (_name, extra) => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, ...extra }))));
    const view = await host.classify(next());
    expect(view.decision).toMatchObject({
      status: 'labeled',
      departmentId: 'billing',
      quote: 'Invoice 18',
      categoryId: null,
      priority: null,
    });
  }, 30_000);

  it('never fills the priority from the category default', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage' }))));
    const view = await host.classify(next());
    expect(view.decision).toMatchObject({ categoryId: 'outage', priority: null });
  }, 30_000);

  it('with no categories the model still gives a priority, and any category id is dropped', async () => {
    const host = hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage', priority: 'low' })));
    const view = await host.classify(next());
    expect(view.decision).toMatchObject({ status: 'labeled', categoryId: null, priority: 'low' });
    expect(lastChat().system).toContain('(no categories)');
  }, 30_000);

  it('a low-confidence department stays needs_review and keeps a valid category and priority', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, confidence: 0.3, categoryId: 'how-to', priority: 'low' }))));
    const view = await host.classify(next());
    expect(view.decision).toMatchObject({ status: 'needs_review', departmentId: null, categoryId: 'how-to', priority: 'low' });
  }, 30_000);

  it('a failed classify stores no category and no priority', async () => {
    const host = withCategories(hostFor(DEAD_URL));
    const view = await host.classify(next());
    expect(view.decision).toMatchObject({ status: 'failed', categoryId: null, priority: null });
  }, 30_000);

  it('admin writes: the first keeps the model value, the second changes only the value, and department fields never move', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage', priority: 'normal' }))));
    host.createCategory({ id: 'hardware', name: 'Hardware', description: '', defaultPriority: 'normal' });
    host.createDepartment({ id: 'it', name: 'IT', description: 'Computers' });
    const view = await host.classify(next());
    const department = {
      departmentId: view.decision.departmentId,
      confidence: view.decision.confidence,
      rationale: view.decision.rationale,
      status: view.decision.status,
      quote: view.decision.quote,
      taxonomyVersion: view.decision.taxonomyVersion,
    };

    const first = host.setCategory({ id: view.id, categoryId: 'how-to' });
    expect(first.decision).toEqual({
      ...view.decision,
      categoryId: 'how-to',
      replacedCategoryId: 'outage',
      categoryReviewed: true,
    });
    const second = host.setCategory({ id: view.id, categoryId: 'hardware' });
    expect(second.decision).toMatchObject({ ...department, categoryId: 'hardware', replacedCategoryId: 'outage', priority: 'normal', priorityReviewed: false });

    const p1 = host.setPriority({ id: view.id, priority: 'urgent' });
    expect(p1.decision).toMatchObject({ ...department, priority: 'urgent', replacedPriority: 'normal', priorityReviewed: true, categoryId: 'hardware' });
    const p2 = host.setPriority({ id: view.id, priority: 'high' });
    expect(p2.decision).toMatchObject({ ...department, priority: 'high', replacedPriority: 'normal', categoryReviewed: true, replacedCategoryId: 'outage' });

    // tickets.override stays department-only.
    const overridden = host.override({ id: view.id, departmentId: 'it' });
    expect(overridden.decision).toMatchObject({
      status: 'overridden',
      departmentId: 'it',
      categoryId: 'hardware',
      replacedCategoryId: 'outage',
      priority: 'high',
      replacedPriority: 'normal',
    });

    expect(() => host.setPriority({ id: view.id, priority: 'critical' as never })).toThrow(/one of low, normal, high, urgent/);
    const missing = '00000000-0000-4000-8000-00000000dead';
    expect(() => host.setPriority({ id: missing, priority: 'low' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => host.setCategory({ id: missing, categoryId: 'how-to' })).toThrow(expect.objectContaining({ code: 'not_found' }));
  }, 30_000);

  it('confirming the model priority counts as a review', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage', priority: 'urgent' }))));
    const view = await host.classify(next());
    expect(host.setPriority({ id: view.id, priority: 'urgent' }).decision).toMatchObject({
      priority: 'urgent',
      replacedPriority: 'urgent',
      priorityReviewed: true,
      categoryReviewed: false,
    });
  }, 30_000);

  it('puts the catalogue in the instruction, keeps ticket text out of it, and keeps the sender block free of priority', async () => {
    const host = withCategories(hostFor(await fakeOllama(() => ({ ...base, categoryId: 'outage', priority: 'high' }))));
    const email = 'ann@example.com';
    const first = await host.classify(next({ email }));
    host.setPriority({ id: first.id, priority: 'urgent' });
    host.setCategory({ id: first.id, categoryId: 'how-to' });
    await host.classify(next({ email, subject: 'Second invoice 18' }));
    const { system, user } = lastChat();
    expect(system).toContain('- id: outage');
    expect(system).toContain('  default priority: urgent');
    expect(system).not.toContain('The secret body text 4711.');
    expect(system).not.toContain('Invoice 18 is wrong');
    expect(user).toContain('The secret body text 4711.');
    expect(user).toContain('earlier tickets from the same sender');
    const block = user.slice(user.indexOf('--- earlier tickets'));
    expect(block).not.toMatch(/priority|categor|urgent|how-to/i);
  }, 30_000);

  it('adds a trend line only from 5 admin-reviewed tickets, by final category; untouched model rows never count', async () => {
    let reply: unknown = { ...base, categoryId: 'outage', priority: 'normal' };
    const host = withCategories(hostFor(await fakeOllama(() => reply)));
    // Model rows nobody reviewed: many, but they must not count.
    for (let i = 0; i < 6; i += 1) await host.classify(next());
    const reviewed = [];
    for (let i = 0; i < 4; i += 1) {
      const view = await host.classify(next());
      host.setPriority({ id: view.id, priority: i < 3 ? 'urgent' : 'high' });
      reviewed.push(view);
    }
    await host.classify(next());
    expect(lastChat().system).not.toContain('Admin priority record');
    expect(lastChat().system).not.toContain('reviewed;');

    const fifth = await host.classify(next());
    host.setPriority({ id: fifth.id, priority: 'urgent' });
    await host.classify(next());
    expect(lastChat().system).toContain(
      '- outage: 5 reviewed; admin result urgent 4/5. Of those 4, the model had said normal on 4.',
    );

    // An admin category move takes a reviewed ticket out of the outage bucket.
    const [moved] = reviewed;
    if (!moved) throw new Error('fixture');
    host.setCategory({ id: moved.id, categoryId: 'how-to' });
    reply = { ...base, categoryId: 'how-to', priority: 'low' };
    await host.classify(next());
    expect(lastChat().system).not.toContain('outage: ');
    expect(lastChat().system).not.toContain('how-to: ');
  }, 60_000);
});

describe('review queue and decision feedback through the host', () => {
  it('lists needs_review and failed tickets oldest first; an override resolves one, a category or priority change does not', async () => {
    let reply: unknown = { departmentId: 'billing', confidence: 0.2, rationale: 'Unsure.' };
    const host = hostFor(await fakeOllama(() => reply));
    host.createCategory({ id: 'outage', name: 'Outage', description: '', defaultPriority: 'urgent' });
    const first = await host.classify({ externalId: 'rq-1', subject: 'A', body: 'x', channel: 'email' });
    await new Promise((r) => setTimeout(r, 3));
    reply = { departmentId: 'billing', confidence: 0.9, rationale: 'Sure.' };
    await host.classify({ externalId: 'rq-2', subject: 'B', body: 'x', channel: 'email' });
    await new Promise((r) => setTimeout(r, 3));
    reply = 'down';
    const third = await host.classify({ externalId: 'rq-3', subject: 'C', body: 'x', channel: 'email' });
    expect(third.decision.status).toBe('failed');

    const queue = host.reviewQueue();
    expect(queue.counts).toEqual({ needsReview: 1, failed: 1 });
    expect(queue.tickets.map((t) => t.id)).toEqual([first.id, third.id]);

    host.setCategory({ id: first.id, categoryId: 'outage' });
    host.setPriority({ id: first.id, priority: 'high' });
    expect(host.reviewQueue().tickets.map((t) => t.id)).toEqual([first.id, third.id]);
    host.override({ id: first.id, departmentId: 'billing' });
    expect(host.reviewQueue()).toMatchObject({ counts: { needsReview: 0, failed: 1 }, tickets: [{ id: third.id }] });

    const feedback = host.decisionFeedback();
    expect(feedback.categories.map((c) => c.id)).toEqual(['outage']);
    expect(feedback.departments.map((d) => d.id)).toEqual(['billing']);
    expect(feedback.items).toHaveLength(1);
    expect(feedback.items[0]).toMatchObject({ ticketId: first.id, categoryReviewed: true, modelCategoryId: null, categoryId: 'outage', priorityReviewed: true, modelPriority: null, priority: 'high' });
  }, 30_000);
});
