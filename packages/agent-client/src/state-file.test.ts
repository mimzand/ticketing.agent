import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectFromStateFile, readStateFile } from './index.js';

const client = { kind: 'test', version: '0.0.0' } as const;
const valid = {
  protocol: 'ticket-agent',
  version: 1,
  host: '127.0.0.1',
  port: 50_000,
  token: 'b'.repeat(43),
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket-client-'));
  path = join(dir, 'agent-state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readStateFile', () => {
  it('reads a valid file', () => {
    writeFileSync(path, JSON.stringify(valid));
    expect(readStateFile(path)).toEqual({ status: 'ok', state: valid });
  });

  it('reports a missing file', () => {
    expect(readStateFile(path)).toEqual({ status: 'missing' });
  });

  it.each(['localhost', '0.0.0.0', '::1', '10.0.0.5'])('treats host %j as invalid', (host) => {
    writeFileSync(path, JSON.stringify({ ...valid, host }));
    expect(readStateFile(path)).toEqual({ status: 'invalid' });
  });
});

describe('connectFromStateFile', () => {
  it('refuses a non-loopback state file without dialing', async () => {
    writeFileSync(path, JSON.stringify({ ...valid, host: '0.0.0.0' }));
    await expect(connectFromStateFile(path, { client })).rejects.toMatchObject({
      code: 'state_file_invalid',
    });
  });

  it('reports a missing agent as not running', async () => {
    await expect(connectFromStateFile(path, { client })).rejects.toMatchObject({
      code: 'not_running',
    });
  });

  it('reports a stale pid as not running, without the token in the message', async () => {
    writeFileSync(path, JSON.stringify(valid));
    const error: unknown = await connectFromStateFile(path, {
      client,
      isProcessAlive: () => false,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'not_running' });
    expect(String((error as Error).message)).not.toContain(valid.token);
  });
});
