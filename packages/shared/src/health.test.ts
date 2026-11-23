import { describe, expect, it } from 'vitest';
import { ApiHealthSchema, ClassifyTicketSchema, DesktopHealthSchema, SenderEmailSchema } from './index.js';

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
        mode: 'spawned',
      }).success,
    ).toBe(true);
  });
});

describe('SenderEmailSchema', () => {
  it('trims and lowercases one address', () => {
    expect(SenderEmailSchema.parse('  Ann@Example.COM ')).toBe('ann@example.com');
    for (const bad of ['', 'ann', 'a@b.com, c@d.com', 'Ann <ann@example.com>', 'a b@example.com', 'a@b.com;c@d.com']) {
      expect(SenderEmailSchema.safeParse(bad).success, bad).toBe(false);
    }
    const ticket = { externalId: 'e', subject: 's', body: '', channel: 'c' };
    expect(ClassifyTicketSchema.parse(ticket).email).toBeUndefined();
    expect(ClassifyTicketSchema.safeParse({ ...ticket, email: 'two@a.com three@b.com' }).success).toBe(false);
  });
});
