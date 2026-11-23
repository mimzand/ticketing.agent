import { describe, expect, it } from 'vitest';
import { sanitizeAdkEnvironment } from './env.js';
import { loadAdkRuntime } from './load.js';

describe('sanitizeAdkEnvironment', () => {
  it('removes a dummy GOOGLE_API_KEY before ADK is loaded', async () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: 'dummy' };
    const report = sanitizeAdkEnvironment(env);
    expect(report.removed).toContain('GOOGLE_API_KEY');
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.OTEL_SDK_DISABLED).toBe('true');
    expect(env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS).toBe('false');
    await loadAdkRuntime(env);
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });
});
