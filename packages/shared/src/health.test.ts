import { describe, expect, it } from 'vitest';
import { ApiHealthSchema, DesktopHealthSchema } from './index.js';

describe('ApiHealthSchema', () => {
  it('accepts both agent states', () => {
    for (const agent of ['connected', 'unavailable'] as const) {
      expect(
        ApiHealthSchema.parse({
          ok: true,
          service: 'ticket-api',
          agent,
          ollama: 'unreachable',
          model: '',
        }),
      ).toEqual({
        ok: true,
        service: 'ticket-api',
        agent,
        ollama: 'unreachable',
        model: '',
      });
    }
  });

  it('rejects extra fields, so nothing like a token can ride along', () => {
    const result = ApiHealthSchema.safeParse({
      ok: true,
      service: 'ticket-api',
      agent: 'connected',
      ollama: 'reachable',
      model: 'qwen3:8b',
      token: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('DesktopHealthSchema', () => {
  it('requires a ping when connected', () => {
    const checkedAt = new Date().toISOString();
    expect(DesktopHealthSchema.safeParse({ agent: 'connected', checkedAt }).success).toBe(false);
    expect(
      DesktopHealthSchema.safeParse({
        agent: 'connected',
        checkedAt,
        ping: { pid: 1, version: '0.1.0', protocolVersion: 1 },
      }).success,
    ).toBe(true);
  });
});
