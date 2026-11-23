import { AgentStateFileSchema } from '@ticket/agent-protocol';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STATE_FILE, resolveStateFilePath, runAgent, writeStateFile } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket-agent-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('state file', () => {
  it('names 127.0.0.1 and every field from the context, and is removed on stop', async () => {
    const stateFile = join(dir, 'nested', 'agent-state.json');
    const agent = await runAgent({ stateFile, agentVersion: '0.1.0' });
    try {
      const raw: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
      const state = AgentStateFileSchema.parse(raw);
      expect(state.host).toBe('127.0.0.1');
      expect(Object.keys(state).sort()).toEqual(
        ['host', 'pid', 'port', 'protocol', 'startedAt', 'token', 'version'].sort(),
      );
      expect(state).toMatchObject({
        protocol: 'ticket-agent',
        version: 1,
        port: agent.server.port,
        pid: process.pid,
      });
    } finally {
      await agent.stop();
    }
    expect(existsSync(stateFile)).toBe(false);
  });

  it.each(['localhost', '0.0.0.0', '::1'])('refuses to write host %j', (host) => {
    const state = {
      protocol: 'ticket-agent' as const,
      version: 1 as const,
      host: host as '127.0.0.1',
      port: 1234,
      token: 'c'.repeat(43),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const path = join(dir, 'agent-state.json');
    expect(() => writeStateFile(path, state)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('defaults to apps/agent/.agent-data and honours AGENT_STATE_FILE', () => {
    expect(DEFAULT_STATE_FILE.replace(/\\/g, '/')).toMatch(/apps\/agent\/\.agent-data\/agent-state\.json$/);
    expect(resolveStateFilePath({})).toBe(DEFAULT_STATE_FILE);
    const custom = join(dir, 'custom.json');
    expect(resolveStateFilePath({ AGENT_STATE_FILE: custom })).toBe(custom);
  });
});
