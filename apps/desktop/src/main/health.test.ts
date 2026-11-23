import { AgentClientError } from '@ticket/agent-client';
import { DesktopHealthSchema } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import { resolveAgentStateFile } from './config.js';
import { readAgentHealth } from './health.js';

const now = () => new Date('2026-01-01T00:00:00.000Z');

describe('readAgentHealth', () => {
  it('reports the ping when the agent answers', async () => {
    const ping = { pid: 42, version: '0.1.0', protocolVersion: 1 };
    const health = await readAgentHealth({ ping: () => Promise.resolve(ping) }, now);
    expect(DesktopHealthSchema.parse(health)).toEqual({
      agent: 'connected',
      ping,
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports a fixed reason when the agent is down', async () => {
    const health = await readAgentHealth(
      { ping: () => Promise.reject(new AgentClientError('not_running', 'secret-ish detail')) },
      now,
    );
    expect(health.agent).toBe('unavailable');
    expect(JSON.stringify(health)).not.toContain('secret-ish detail');
  });
});

describe('resolveAgentStateFile', () => {
  it('honours AGENT_STATE_FILE, else uses the agent default', () => {
    const base = '/repo/apps/desktop';
    expect(resolveAgentStateFile({}, base).replace(/\\/g, '/')).toMatch(
      /apps\/agent\/\.agent-data\/agent-state\.json$/,
    );
    expect(resolveAgentStateFile({ AGENT_STATE_FILE: '/tmp/x.json' }, base).replace(/\\/g, '/')).toMatch(
      /\/tmp\/x\.json$/,
    );
  });
});
