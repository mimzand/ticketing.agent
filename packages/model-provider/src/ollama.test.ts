import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOllamaClient, loadOllamaConfig, OllamaError, parseOllamaBaseUrl } from './ollama.js';

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

function listen(handler: (body: string, authorization: string | undefined) => { status: number; json: unknown }): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const result = handler(Buffer.concat(chunks).toString('utf8'), req.headers.authorization);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (address && typeof address !== 'string') resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe('parseOllamaBaseUrl', () => {
  it('rejects credentials, a query, and a fragment', () => {
    expect(() => parseOllamaBaseUrl('http://user:pass@127.0.0.1:11434')).toThrow(/credentials/);
    expect(() => parseOllamaBaseUrl('http://127.0.0.1:11434/api?x=1')).toThrow(/query/);
    expect(() => parseOllamaBaseUrl('http://127.0.0.1:11434/#frag')).toThrow(/fragment/);
    expect(() => parseOllamaBaseUrl('ftp://127.0.0.1')).toThrow(/http/);
  });
});

describe('createOllamaClient', () => {
  it('sends the bearer token to loopback and withholds it from other http hosts', async () => {
    let seen: string | undefined;
    const local = await listen((_body, authorization) => {
      seen = authorization;
      return { status: 200, json: { models: [] } };
    });
    const loopback = createOllamaClient({
      baseUrl: local,
      model: 'test',
      token: 'secret-token',
      timeoutMs: 1_000,
    });
    await loopback.checkReachable();
    expect(seen).toBe('Bearer secret-token');

    const publicHost = createOllamaClient(
      { baseUrl: 'http://example.test', model: 'test', token: 'secret-token', timeoutMs: 1_000 },
      (async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen = headers.get('authorization') ?? undefined;
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }) as typeof fetch,
    );
    await publicHost.checkReachable();
    expect(seen).toBeUndefined();
  });

  it('refuses a redirect and does not follow it', async () => {
    const baseUrl = await listen(() => ({ status: 200, json: {} }));
    const client = createOllamaClient(
      { baseUrl, model: 'test', token: undefined, timeoutMs: 1_000 },
      (async () => new Response(null, { status: 307, headers: { location: 'http://evil.test' } })) as typeof fetch,
    );
    await expect(client.generate({ system: 's', user: 'u' })).rejects.toThrow(/not followed/);
  });

  it('returns the assistant message from a chat response', async () => {
    const baseUrl = await listen((body) => {
      const parsed = JSON.parse(body) as { messages: { role: string }[] };
      expect(parsed.messages.map((message) => message.role)).toEqual(['system', 'user']);
      return { status: 200, json: { message: { role: 'assistant', content: '{"ok":true}' } } };
    });
    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_HOST: baseUrl, OLLAMA_MODEL: 'test' }));
    await expect(client.generate({ system: 'rules', user: 'ticket' })).resolves.toBe('{"ok":true}');
  });

  const respond = (status: number, body: string | null) =>
    (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const config = { baseUrl: 'http://127.0.0.1:1', model: 'm', token: undefined, timeoutMs: 1_000 };

  it.each([
    ['HTTP 503 with its status', respond(503, '{}'), { code: 'http', status: 503 }],
    ['HTTP 400 with its status', respond(400, '{}'), { code: 'http', status: 400 }],
    ['a body that is not JSON', respond(200, 'not json'), { code: 'invalid-response', status: null }],
    ['no assistant message', respond(200, '{"message":{}}'), { code: 'invalid-response' }],
    ['an empty assistant message', respond(200, '{"message":{"role":"assistant","content":"  "}}'), { code: 'empty-response' }],
    [
      'a network failure',
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      { code: 'network' },
    ],
  ])('types %s', async (_name, fetchImpl, expected) => {
    const error = await createOllamaClient(config, fetchImpl)
      .generate({ system: 's', user: 'u' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaError);
    expect(error).toMatchObject(expected);
  });

  it('types a timeout and an invalid URL', async () => {
    const slow = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      })) as typeof fetch;
    await expect(
      createOllamaClient({ ...config, generateTimeoutMs: 20 }, slow).generate({ system: 's', user: 'u' }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(
      createOllamaClient({ ...config, baseUrl: 'not a url' }, respond(200, '{}')).generate({ system: 's', user: 'u' }),
    ).rejects.toMatchObject({ code: 'invalid-url' });
  });
});
