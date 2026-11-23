import { type ModelReply } from './suite.js';

/** Never contacted: every request goes to the in-process fake below. */
export const FAKE_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const FAKE_OLLAMA_MODEL = 'eval-model';

export interface FakeOllama {
  /** Passed to createAgentHost as `fetch`. No socket is opened. */
  readonly fetch: typeof fetch;
  /** Replies not consumed yet (the host called the model fewer times than scripted). */
  remaining(): number;
  /** Chat requests beyond the scripted replies. */
  unexpectedCalls(): number;
  /** What each chat request carried, in order (for tests; never printed by the CLI). */
  readonly requests: { readonly system: string; readonly user: string }[];
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake Ollama as a `fetch` function: `/api/tags` lists the eval model, and each
 * `/api/chat` answers the next reply in order.
 */
export function createFakeOllama(replies: readonly ModelReply[]): FakeOllama {
  const queue = [...replies];
  const requests: { system: string; user: string }[] = [];
  let unexpected = 0;

  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/api/tags') return json(200, { models: [{ name: FAKE_OLLAMA_MODEL, size: 1 }] });
    if (url.pathname !== '/api/chat') return json(404, { error: 'not found' });

    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      messages?: { role: string; content: string }[];
    };
    const message = (role: string) => body.messages?.find((m) => m.role === role)?.content ?? '';
    requests.push({ system: message('system'), user: message('user') });

    const reply = queue.shift();
    if (!reply) {
      unexpected += 1;
      return json(500, { error: 'no scripted reply left' });
    }
    switch (reply.kind) {
      case 'scripted':
        return json(200, { message: { role: 'assistant', content: JSON.stringify(reply.output) } });
      case 'recorded':
        return json(200, { message: { role: 'assistant', content: reply.content } });
      case 'error':
        return json(reply.status, { error: 'scripted error' });
    }
  };

  return {
    fetch: fake as typeof fetch,
    remaining: () => queue.length,
    unexpectedCalls: () => unexpected,
    requests,
  };
}
