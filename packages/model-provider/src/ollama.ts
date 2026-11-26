export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen3:8b';
export const OLLAMA_DEFAULT_TIMEOUT_MS = 5_000;
export const OLLAMA_GENERATE_TIMEOUT_MS = 120_000;

export type OllamaErrorCode =
  | 'invalid-url'
  | 'redirect'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'empty-response';

/**
 * A typed Ollama failure. Callers decide on `code` (and `status` for `http`), never on
 * the message. Messages are fixed text: no URL, no token, no response body.
 */
export class OllamaError extends Error {
  constructor(
    readonly code: OllamaErrorCode,
    message: string,
    /** The HTTP status, for `code: 'http'`. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface OllamaConfig {
  readonly baseUrl: string;
  readonly model: string;
  /** Sent only over HTTPS or to a loopback host. */
  readonly token: string | undefined;
  readonly timeoutMs: number;
  /** Limit for one classify (chat) request. Defaults to OLLAMA_GENERATE_TIMEOUT_MS. */
  readonly generateTimeoutMs?: number;
}

export interface OllamaModelInfo {
  readonly name: string;
  readonly size: number | null;
}

/** `http:` or `https:` only, with no userinfo, query, or fragment. */
export function parseOllamaBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OllamaError('invalid-url', 'OLLAMA_HOST is not an http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaError('invalid-url', 'OLLAMA_HOST must use http or https.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OllamaError('invalid-url', 'OLLAMA_HOST must not include credentials, a query, or a fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

export function loadOllamaConfig(env: NodeJS.ProcessEnv): OllamaConfig {
  const host = env['OLLAMA_HOST']?.trim();
  const model = env['OLLAMA_MODEL']?.trim() || OLLAMA_DEFAULT_MODEL;
  const token = env['OLLAMA_TOKEN']?.trim() || undefined;
  return {
    baseUrl: parseOllamaBaseUrl(host || OLLAMA_DEFAULT_BASE_URL),
    model,
    token,
    timeoutMs: OLLAMA_DEFAULT_TIMEOUT_MS,
  };
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Bearer token only for HTTPS or a loopback address. */
export function canSendToken(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'https:' || isLoopback(url.hostname);
}

export interface OllamaClient {
  readonly config: OllamaConfig;
  /** GET /api/tags. False when the server cannot be reached. */
  checkReachable(signal?: AbortSignal): Promise<boolean>;
  /** GET /api/tags. Throws OllamaError when the server cannot be reached or answers badly. */
  listModels(signal?: AbortSignal): Promise<readonly OllamaModelInfo[]>;
  /** One non-streaming JSON chat completion. The text is the assistant message. */
  generate(input: { readonly system: string; readonly user: string }, signal?: AbortSignal): Promise<string>;
}

export function createOllamaClient(config: OllamaConfig, fetchImpl: typeof fetch = fetch): OllamaClient {
  async function request(path: string, init: { readonly method: string; readonly body?: string }, signal?: AbortSignal, timeoutMs = config.timeoutMs): Promise<Response> {
    let url: URL;
    try {
      url = new URL(path, `${config.baseUrl}/`);
    } catch {
      throw new OllamaError('invalid-url', 'The Ollama server URL is not valid.');
    }
    const headers = new Headers({ accept: 'application/json' });
    if (init.body) headers.set('content-type', 'application/json');
    if (config.token && canSendToken(config.baseUrl)) headers.set('authorization', `Bearer ${config.token}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new OllamaError('timeout', 'The Ollama request timed out.');
      }
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new OllamaError('network', 'The Ollama server is not reachable.');
    });
    if (response.status >= 300 && response.status < 400) {
      throw new OllamaError('redirect', 'Redirects are not followed.');
    }
    return response;
  }

  return {
    config,
    async checkReachable(signal) {
      try {
        const response = await request('/api/tags', { method: 'GET' }, signal);
        return response.ok;
      } catch {
        return false;
      }
    },
    async listModels(signal) {
      const response = await request('/api/tags', { method: 'GET' }, signal);
      if (!response.ok) throw new OllamaError('http', `Ollama returned HTTP ${response.status}.`, response.status);
      const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
      if (!body || !Array.isArray(body.models)) {
        throw new OllamaError('invalid-response', 'Ollama returned no model list.');
      }
      return body.models.flatMap((item: unknown) => {
        if (typeof item !== 'object' || item === null) return [];
        const { name, size } = item as { name?: unknown; size?: unknown };
        if (typeof name !== 'string' || name.length === 0 || name.length > 256) return [];
        return [{ name, size: typeof size === 'number' && Number.isFinite(size) ? size : null }];
      });
    },
    async generate(input, signal) {
      const response = await request(
        '/api/chat',
        {
          method: 'POST',
          body: JSON.stringify({
            model: config.model,
            stream: false,
            think: false,
            format: 'json',
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
          }),
        },
        signal,
        config.generateTimeoutMs ?? OLLAMA_GENERATE_TIMEOUT_MS,
      );
      if (!response.ok) throw new OllamaError('http', `Ollama returned HTTP ${response.status}.`, response.status);
      const body = (await response.json().catch(() => null)) as { message?: { content?: unknown } } | null;
      if (typeof body?.message?.content !== 'string') {
        throw new OllamaError('invalid-response', 'Ollama returned no assistant message.');
      }
      if (body.message.content.trim() === '') {
        throw new OllamaError('empty-response', 'Ollama returned an empty assistant message.');
      }
      return body.message.content;
    },
  };
}
