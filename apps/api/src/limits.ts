import { createHash } from 'node:crypto';
import { type MiddlewareHandler } from 'hono';
import { API_KEY_HEADER } from './security.js';

/* ------------------------------------------------------------------------ CORS */

/** The request headers the API accepts from a browser. */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'X-API-Key', 'Authorization'] as const;
export const CORS_ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

/** `http(s)://host[:port]` exactly, normalised; anything else is null. */
function normaliseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/**
 * CORS_ORIGINS: a comma-separated allow-list of exact origins. Empty (the default)
 * allows no browser cross-origin call. `*`, a path, or a non-http(s) origin stops the
 * API at startup instead of being guessed at.
 */
export function parseCorsOrigins(raw: string | undefined): readonly string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.map((entry) => {
    if (entry.includes('*')) throw new Error('CORS_ORIGINS lists exact origins; "*" is not allowed.');
    const origin = normaliseOrigin(entry);
    if (!origin || origin !== entry.replace(/\/$/, '').toLowerCase()) {
      throw new Error(`CORS_ORIGINS has an entry that is not an origin like https://host:port: ${entry.slice(0, 100)}`);
    }
    return origin;
  });
}

/**
 * A listed Origin gets exactly that origin back in Access-Control-Allow-Origin. An
 * unlisted one gets no CORS header at all (never `*`, never a reflection). Preflights
 * are answered here, before the API-key check, because browsers send them without the key.
 */
export function corsAllowlist(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return async (c, next) => {
    const header = c.req.header('origin');
    const origin = header ? normaliseOrigin(header) : null;
    const listed = origin !== null && allowed.has(origin);
    const preflight = c.req.method === 'OPTIONS' && header !== undefined && c.req.header('access-control-request-method') !== undefined;

    if (preflight) {
      c.header('Vary', 'Origin');
      if (!listed) return c.body(null, 204);
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS.join(', '));
      c.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS.join(', '));
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }

    await next();
    if (allowed.size > 0) c.res.headers.append('Vary', 'Origin');
    if (listed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Access-Control-Expose-Headers', 'Retry-After');
    }
    return undefined;
  };
}

/* ------------------------------------------------------------------ Rate limit */

export const CLASSIFY_RATE_LIMIT = 30;
export const CLASSIFY_RATE_WINDOW_MS = 60_000;
export const CLASSIFY_PATH = '/v1/tickets:classify';

export interface RateLimiter {
  /** Counts one request for `key`. `retryAfterSeconds` is set when it is over the limit (and not counted). */
  take(key: string): { readonly allowed: boolean; readonly retryAfterSeconds: number };
}

/** Sliding one-minute window per key, in memory, for this process only. */
export function createRateLimiter(options: {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
} = {}): RateLimiter {
  const limit = options.limit ?? CLASSIFY_RATE_LIMIT;
  const windowMs = options.windowMs ?? CLASSIFY_RATE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => at > t - windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? t;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      // Keys with nothing recent are dropped so the map does not grow.
      for (const [other, times] of hits) {
        if (other !== key && times.every((at) => at <= t - windowMs)) hits.delete(other);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * Limits POST /v1/tickets:classify per API key. Runs after the API-key check, so a
 * missing or wrong key is a 401 and is never counted. The key is held as a digest.
 */
export function classifyRateLimit(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'POST' || c.req.path !== CLASSIFY_PATH) return next();
    const header = c.req.header(API_KEY_HEADER);
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const key = createHash('sha256').update((header ?? bearer ?? '').trim(), 'utf8').digest('hex');
    const verdict = limiter.take(key);
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfterSeconds));
      return c.json(
        {
          error: {
            code: 'rate_limited',
            message: `Too many classify requests for this API key (at most ${CLASSIFY_RATE_LIMIT} per minute). Retry after ${verdict.retryAfterSeconds} s.`,
          },
        },
        429,
      );
    }
    return next();
  };
}
