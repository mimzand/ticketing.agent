import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type MiddlewareHandler } from 'hono';

export const API_KEY_HEADER = 'x-api-key';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** `X-API-Key` or `Authorization: Bearer`, compared in constant time on a digest. */
export function apiKeyAuth(apiKey: string): MiddlewareHandler {
  const expected = digest(apiKey);
  return async (c, next) => {
    if (c.req.path === '/health') return next();
    const header = c.req.header(API_KEY_HEADER);
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const given = (header ?? bearer)?.trim();
    const matches =
      given !== undefined &&
      given.length > 0 &&
      timingSafeEqual(digest(given), expected);
    if (!matches) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Missing or wrong API key (X-API-Key).' } },
        401,
      );
    }
    return next();
  };
}

export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** A key for this process when API_KEY is unset on loopback. The caller prints it once. */
export function resolveApiKey(env: NodeJS.ProcessEnv, host: string): { readonly key: string; readonly generated: boolean } {
  const configured = env['API_KEY']?.trim();
  if (configured) return { key: configured, generated: false };
  if (!isLoopbackHost(host)) {
    throw new Error('API_KEY is required when API_HOST is not a loopback address.');
  }
  return { key: randomBytes(24).toString('base64url'), generated: true };
}
