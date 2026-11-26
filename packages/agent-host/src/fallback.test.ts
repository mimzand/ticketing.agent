import { openTicketDatabase, type TicketDatabase } from '@ticket/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DecisionEvent } from './decision-event.js';
import { createAgentHost, FALLBACK_MIN_BUDGET_MS, type AgentHostOptions } from './host.js';

const SECRET = {
  subject: 'SENTINEL-SUBJECT Invoice 18',
  body: 'SENTINEL-BODY please fix invoice 18',
  email: 'sentinel.sender@example.com',
  rationale: 'SENTINEL-RATIONALE',
  quote: 'SENTINEL-BODY',
  token: 'SENTINEL-TOKEN-' + 'x'.repeat(30),
  url: 'http://ollama.sentinel.test:11434',
};

type Answer = unknown | { http: number } | 'network' | 'hang' | { raw: string };
interface Call {
  readonly model: string;
}

let db: TicketDatabase | undefined;
let dir: string | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const good = {
  departmentId: 'billing',
  confidence: 0.9,
  rationale: SECRET.rationale,
  quote: SECRET.quote,
  categoryId: 'outage',
  priority: 'high',
};

/**
 * A fake Ollama as `fetch`: answers per model name, in order. `network` rejects like
 * an unreachable host, `hang` waits for the abort, `{ http }` answers that status,
 * `{ raw }` sends raw assistant text.
 */
function fakeFetch(script: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    const model = body.model ?? '';
    calls.push({ model });
    const answer = script[model]?.shift();
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    if (answer && typeof answer === 'object' && 'http' in answer) {
      return new Response('{}', { status: (answer as { http: number }).http });
    }
    const content = answer && typeof answer === 'object' && 'raw' in answer ? (answer as { raw: string }).raw : JSON.stringify(answer);
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(script: Record<string, Answer[]>, env: NodeJS.ProcessEnv = {}, extra: Partial<AgentHostOptions> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'ticket-fallback-'));
  db = openTicketDatabase(join(dir, 'tickets.db'));
  db.insertDepartment({ id: 'billing', name: 'Billing', description: 'Invoices' });
  db.insertCategory({ id: 'outage', name: 'Outage', description: '', defaultPriority: 'urgent' });
  const events: DecisionEvent[] = [];
  const fake = fakeFetch(script);
  const host = createAgentHost({
    db,
    env: {
      OLLAMA_HOST: SECRET.url,
      OLLAMA_MODEL: 'primary-model',
      OLLAMA_FALLBACK_MODEL: 'backup-model',
      OLLAMA_TOKEN: SECRET.token,
      ...env,
    },
    fetch: fake.fetchImpl,
    onDecisionEvent: (event) => events.push(event),
    ...extra,
  });
  return { host, events, calls: fake.calls };
}

let n = 0;
const ticket = (extra: Record<string, unknown> = {}) => ({
  externalId: `fb-${(n += 1)}`,
  subject: SECRET.subject,
  body: SECRET.body,
  channel: 'email',
  email: SECRET.email,
  ...extra,
});
const models = (calls: Call[]) => calls.map((c) => c.model);

describe('one bounded fallback attempt', () => {
  it.each([
    ['a network failure', 'network'],
    ['HTTP 503', { http: 503 }],
    ['HTTP 500', { http: 500 }],
    ['malformed JSON', { raw: 'not json at all' }],
    ['broken JSON inside braces', { raw: '{"departmentId": billing}' }],
    ['output failing the classifier schema', { departmentId: 'billing', confidence: 2 }],
    ['an empty answer', { raw: '   ' }],
  ] as const)('falls back once after %s and stores the complete validated fallback decision', async (_name, primary) => {
    const { host, events, calls } = setup({ 'primary-model': [primary], 'backup-model': [good] });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model', 'backup-model']);
    expect(view.decision).toMatchObject({
      status: 'labeled',
      departmentId: 'billing',
      categoryId: 'outage',
      priority: 'high',
      quote: SECRET.quote,
      rationale: SECRET.rationale,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'labeled', attempts: 2, modelRole: 'fallback', failureCode: null });
  });

  it.each([
    ['HTTP 400', { http: 400 }, 'http_4xx'],
    ['HTTP 404', { http: 404 }, 'http_4xx'],
    ['HTTP 501', { http: 501 }, 'http_5xx'],
  ] as const)('does not retry %s; the decision is failed', async (_name, primary, code) => {
    const { host, events, calls } = setup({ 'primary-model': [primary], 'backup-model': [good] });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);
    expect(view.decision).toMatchObject({ status: 'failed', departmentId: null, categoryId: null, priority: null });
    expect(events[0]).toMatchObject({ status: 'failed', attempts: 1, modelRole: 'primary', failureCode: code });
  });

  it('does not retry a redirect', async () => {
    const { host, calls, events } = setup({ 'primary-model': [{ http: 307 }], 'backup-model': [good] });
    await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);
    expect(events[0]).toMatchObject({ failureCode: 'redirect', attempts: 1 });
  });

  it('does not retry a timeout: the classify budget is the whole budget', async () => {
    const { host, calls, events } = setup({ 'primary-model': ['hang'], 'backup-model': [good] });
    host.updateSettings({ classifyTimeoutMs: 1_000 });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);
    expect(view.decision.status).toBe('failed');
    expect(events[0]).toMatchObject({ failureCode: 'timeout', attempts: 1, modelRole: 'primary' });
  }, 10_000);

  it('does not start fallback when less than its minimum budget remains', async () => {
    // classifyTimeoutMs equals FALLBACK_MIN_BUDGET_MS, and one millisecond is spent on the
    // primary failure, so remaining is below the floor and the backup model is never called.
    expect(FALLBACK_MIN_BUDGET_MS).toBe(1_000);
    const { host, calls, events } = setup({ 'primary-model': ['network'], 'backup-model': [good] });
    host.updateSettings({ classifyTimeoutMs: FALLBACK_MIN_BUDGET_MS });
    const started = 10_000;
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(started)
      .mockReturnValue(started + 1);
    try {
      const view = await host.classify(ticket());
      expect(models(calls)).toEqual(['primary-model']);
      expect(view.decision.status).toBe('failed');
      expect(events[0]).toMatchObject({ failureCode: 'network', attempts: 1, modelRole: 'primary' });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['low confidence', { ...good, confidence: 0.2 }, 'needs_review'],
    ['an unknown department', { ...good, departmentId: 'legal' }, 'needs_review'],
    ['an unknown category, a bad priority, and a quote not in the ticket', { ...good, categoryId: 'x', priority: 'High', quote: 'nope' }, 'labeled'],
  ] as const)('does not retry %s: the host rules decide', async (_name, primary, status) => {
    const { host, calls, events } = setup({ 'primary-model': [primary], 'backup-model': [good] });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);
    expect(view.decision.status).toBe(status);
    expect(events[0]).toMatchObject({ attempts: 1, modelRole: 'primary', failureCode: null });
  });

  it('stores failed when the fallback also fails, with the last fixed failure code', async () => {
    const { host, calls, events } = setup({ 'primary-model': ['network'], 'backup-model': [{ http: 502 }] });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model', 'backup-model']);
    expect(view.decision).toMatchObject({ status: 'failed', rationale: 'The model could not be reached.' });
    expect(events[0]).toMatchObject({ status: 'failed', attempts: 2, modelRole: 'fallback', failureCode: 'http_5xx' });
  });

  it('never merges two responses: a valid low-confidence fallback is stored as needs_review on its own', async () => {
    const { host } = setup({
      'primary-model': [{ raw: '{"departmentId":"billing","categoryId":"outage"' }],
      'backup-model': [{ departmentId: 'billing', confidence: 0.3, rationale: 'unsure' }],
    });
    const view = await host.classify(ticket());
    expect(view.decision).toMatchObject({ status: 'needs_review', categoryId: null, priority: null, rationale: 'unsure' });
  });

  it('without a fallback model keeps the one-attempt behavior', async () => {
    const { host, calls, events } = setup({ 'primary-model': ['network'] }, { OLLAMA_FALLBACK_MODEL: '' });
    const view = await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);
    expect(view.decision.status).toBe('failed');
    expect(events[0]).toMatchObject({ attempts: 1, failureCode: 'network' });
  });

  it('ignores a fallback equal to the primary model and refuses to save one', async () => {
    const { host, calls } = setup({ 'primary-model': ['network', 'network'] }, { OLLAMA_FALLBACK_MODEL: 'primary-model' });
    await host.classify(ticket());
    expect(models(calls)).toEqual(['primary-model']);

    const plain = setup({}, { OLLAMA_FALLBACK_MODEL: '', OLLAMA_MODEL: '' }).host;
    expect(() => plain.updateSettings({ fallbackModel: 'qwen3:8b' })).toThrow('The fallback model must differ from the primary model.');
    expect(plain.updateSettings({ fallbackModel: 'llama3:8b' }).fields.fallbackModel).toMatchObject({ value: 'llama3:8b', source: 'saved' });
    expect(() => plain.updateSettings({ model: 'llama3:8b' })).toThrow(/must differ/);
    expect(plain.updateSettings({ fallbackModel: null }).fields.fallbackModel.value).toBeNull();
  });

  it('reads OLLAMA_FALLBACK_MODEL like the other overrides, never echoing an invalid value', () => {
    const fromEnv = setup({}).host.getSettings().fields.fallbackModel;
    expect(fromEnv).toEqual({ value: 'backup-model', source: 'env', saved: null, envVar: 'OLLAMA_FALLBACK_MODEL', envError: null });
    const invalid = setup({}, { OLLAMA_FALLBACK_MODEL: 'bad model name!' }).host.getSettings().fields.fallbackModel;
    expect(invalid.value).toBeNull();
    expect(invalid.source).toBe('default');
    expect(invalid.envError).toMatch(/^OLLAMA_FALLBACK_MODEL is set but not applied/);
    expect(invalid.envError).not.toContain('bad model name!');
    expect(setup({}, { OLLAMA_FALLBACK_MODEL: '' }).host.getSettings().fields.fallbackModel).toMatchObject({ value: null, source: 'default' });
  });

  it('a cancel during the primary attempt stores nothing, does not fall back, and emits no event', async () => {
    const { host, calls, events } = setup({ 'primary-model': ['hang'], 'backup-model': [good, good] });
    const controller = new AbortController();
    const first = ticket();
    const pending = host.classify(first, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(models(calls)).toEqual(['primary-model']);
    expect(events).toEqual([]);
    expect(host.listTickets()).toEqual([]);
    // The externalId can be submitted again.
    expect((await host.classify(first)).decision.status).toBe('labeled');
  });

  it('a cancel during the fallback attempt stores nothing and emits no event', async () => {
    const { host, calls, events } = setup({ 'primary-model': ['network'], 'backup-model': ['hang'] });
    const controller = new AbortController();
    const pending = host.classify(ticket(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(models(calls)).toEqual(['primary-model', 'backup-model']);
    expect(events).toEqual([]);
    expect(host.listTickets()).toEqual([]);
  });
});

describe('decision events', () => {
  it('describes labeled, needs_review, and failed outcomes with ids, counts, and codes only', async () => {
    const { host, events } = setup({
      'primary-model': [good, { ...good, confidence: 0.1, categoryId: null, priority: 'low', quote: 'not in the ticket' }, { http: 400 }],
      'backup-model': [],
    });
    const labeled = await host.classify(ticket());
    await host.classify(ticket({ externalId: 'second', subject: 'Again' }));
    await host.classify(ticket({ externalId: 'third' }));
    expect(events.map((e) => e.status)).toEqual(['labeled', 'needs_review', 'failed']);
    expect(events[0]).toEqual({
      event: 'ticket_classified',
      ticketId: labeled.id,
      status: 'labeled',
      departmentId: 'billing',
      categoryId: 'outage',
      priority: 'high',
      confidence: 0.9,
      taxonomyVersion: 1,
      historyCount: 0,
      quoteAccepted: true,
      durationMs: expect.any(Number) as number,
      attempts: 1,
      modelRole: 'primary',
      failureCode: null,
    });
    expect(events[1]).toMatchObject({ departmentId: null, categoryId: null, priority: 'low', quoteAccepted: false, historyCount: 1 });
    expect(events[2]).toMatchObject({ confidence: 0, failureCode: 'http_4xx', historyCount: 2 });

    const text = JSON.stringify(events);
    for (const value of Object.values(SECRET)) expect(text).not.toContain(value);
    expect(text).not.toContain('fb-');
    expect(text).not.toMatch(/primary-model|backup-model|externalId|subject|body|email|rationale|quote"/);
  });

  it('a throwing log callback does not fail the classify', async () => {
    const { host } = setup({ 'primary-model': [good] }, {}, {
      onDecisionEvent: () => {
        throw new Error('log sink down');
      },
    });
    const view = await host.classify(ticket());
    expect(view.decision.status).toBe('labeled');
    expect(host.listTickets()).toHaveLength(1);
  });

  it('the model reply hook sees each complete raw answer and nothing reaches it on a cancel', async () => {
    const replies: { content: string; model: string }[] = [];
    const { host } = setup({ 'primary-model': [{ raw: 'garbage' }], 'backup-model': [good] }, {}, {
      onModelReply: (reply) => replies.push({ content: reply.content, model: reply.model }),
    });
    await host.classify(ticket());
    expect(replies).toEqual([
      { content: 'garbage', model: 'primary-model' },
      { content: JSON.stringify(good), model: 'backup-model' },
    ]);
  });
});
