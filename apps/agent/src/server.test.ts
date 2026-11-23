import {
  encodeFrame,
  FrameDecoder,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Envelope,
} from '@ticket/agent-protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateToken,
  runAgent,
  startAgentServer,
  tokensEqual,
  writeStateFile,
  type AgentServer,
} from './index.js';

const token = generateToken();
let server: AgentServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Probe {
  readonly socket: Socket;
  send(envelope: Envelope): void;
  next(): Promise<Envelope>;
  closed: Promise<void>;
}

async function probe(port: number): Promise<Probe> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const decoder = new FrameDecoder();
  const queue: Envelope[] = [];
  const waiters: ((e: Envelope) => void)[] = [];
  socket.on('data', (chunk: Buffer) => {
    for (const r of decoder.push(chunk)) {
      if (!r.ok) throw new Error(r.error.message);
      const waiter = waiters.shift();
      if (waiter) waiter(r.value);
      else queue.push(r.value);
    }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    socket,
    send: (envelope) => socket.write(encodeFrame(envelope)),
    next: () => {
      const queued = queue.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    },
    closed,
  };
}

const hello = (t: string): Envelope => ({
  id: 'h1',
  kind: 'req',
  method: 'system.hello',
  payload: {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    token: t,
    client: { kind: 'test', version: '0.0.0' },
  },
});
const ping: Envelope = { id: 'p1', kind: 'req', method: 'system.ping', payload: {} };

describe('agent server', () => {
  it('listens on 127.0.0.1 only', async () => {
    server = await startAgentServer({ token, agentVersion: '0.1.0' });
    expect(server.host).toBe('127.0.0.1');
  });

  it('answers system.hello, then system.ping', async () => {
    server = await startAgentServer({ token, agentVersion: '0.1.0' });
    const p = await probe(server.port);
    p.send(hello(token));
    const ack = await p.next();
    expect(ack).toMatchObject({
      kind: 'res',
      method: 'system.hello',
      payload: { protocol: 'ticket-agent', version: 1, agent: { pid: process.pid } },
    });
    p.send(ping);
    expect(await p.next()).toEqual({
      id: 'p1',
      kind: 'res',
      method: 'system.ping',
      payload: { pid: process.pid, version: '0.1.0', protocolVersion: 1 },
    });
    p.socket.destroy();
  });

  it('rejects a bad token and closes the connection', async () => {
    server = await startAgentServer({ token, agentVersion: '0.1.0' });
    const p = await probe(server.port);
    p.send(hello(generateToken()));
    expect(await p.next()).toMatchObject({
      kind: 'error',
      payload: { code: 'unauthorized', message: 'Invalid token.' },
    });
    await p.closed;
  });

  it('rejects any first message other than system.hello', async () => {
    server = await startAgentServer({ token, agentVersion: '0.1.0' });
    const p = await probe(server.port);
    p.send(ping);
    expect(await p.next()).toMatchObject({ kind: 'error', payload: { code: 'unauthorized' } });
    await p.closed;
  });

  it('disconnects a client that does not finish the handshake in time', async () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    server = await startAgentServer({ token, agentVersion: '0.1.0', handshakeTimeoutMs: 50 });
    const p = await probe(server.port);
    expect(await p.next()).toMatchObject({
      kind: 'error',
      payload: { code: 'unauthorized', message: 'Handshake timed out.' },
    });
    await p.closed;
  });

  it('refuses to start with a weak token', async () => {
    await expect(startAgentServer({ token: 'short', agentVersion: '0.1.0' })).rejects.toThrow();
  });
});

describe('tokensEqual', () => {
  it('compares tokens of any length', () => {
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, `${token}x`)).toBe(false);
    expect(tokensEqual('', token)).toBe(false);
    expect(tokensEqual(generateToken(), token)).toBe(false);
  });
});

describe('settings.setToken', () => {
  const ollamaToken = 'ollama_' + 'z'.repeat(40);
  const received: (string | null)[] = [];
  const calls = {
    setToken: (value: string | null) => {
      received.push(value);
      return { tokenSet: value !== null };
    },
  } as unknown as NonNullable<Parameters<typeof startAgentServer>[0]['calls']>;

  const helloAs = (kind: 'shell' | 'cli'): Envelope => ({
    id: 'h1',
    kind: 'req',
    method: 'system.hello',
    payload: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, token, client: { kind, version: '0.0.0' } },
  });
  const setToken: Envelope = { id: 's1', kind: 'req', method: 'settings.setToken', payload: { token: ollamaToken } };

  it('is refused for a cli client such as the HTTP API', async () => {
    received.length = 0;
    server = await startAgentServer({ token, agentVersion: '0.1.0', calls });
    const p = await probe(server.port);
    p.send(helloAs('cli'));
    await p.next();
    p.send(setToken);
    const answer = await p.next();
    expect(answer).toMatchObject({ kind: 'error', payload: { code: 'forbidden' } });
    expect(JSON.stringify(answer)).not.toContain(ollamaToken);
    expect(received).toEqual([]);
    p.socket.destroy();
  });

  it('is accepted from the desktop shell and answers only whether a token is set', async () => {
    received.length = 0;
    server = await startAgentServer({ token, agentVersion: '0.1.0', calls });
    const p = await probe(server.port);
    p.send(helloAs('shell'));
    await p.next();
    p.send(setToken);
    const answer = await p.next();
    expect(answer).toEqual({ id: 's1', kind: 'res', method: 'settings.setToken', payload: { tokenSet: true } });
    expect(received).toEqual([ollamaToken]);
    p.socket.destroy();
  });
});

describe('system.shutdown', () => {
  const helloAs = (kind: 'shell' | 'cli'): Envelope => ({
    id: 'h1',
    kind: 'req',
    method: 'system.hello',
    payload: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, token, client: { kind, version: '0.0.0' } },
  });
  const shutdown: Envelope = { id: 'x1', kind: 'req', method: 'system.shutdown', payload: {} };

  it('is refused for a cli client and accepted from the shell', async () => {
    let stops = 0;
    server = await startAgentServer({ token, agentVersion: '0.1.0', onShutdown: () => void (stops += 1) });
    const cli = await probe(server.port);
    cli.send(helloAs('cli'));
    await cli.next();
    cli.send(shutdown);
    expect(await cli.next()).toMatchObject({ kind: 'error', payload: { code: 'forbidden' } });
    cli.socket.destroy();

    const shell = await probe(server.port);
    shell.send(helloAs('shell'));
    await shell.next();
    shell.send(shutdown);
    expect(await shell.next()).toEqual({ id: 'x1', kind: 'res', method: 'system.shutdown', payload: null });
    await new Promise((r) => setImmediate(r));
    expect(stops).toBe(1);
    shell.socket.destroy();
  });
});

describe('single writer', () => {
  it('refuses to start next to a live agent for the same state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-single-'));
    const env = { TICKET_DATA_DIR: join(dir, 'tickets.db') };
    const stateFile = join(dir, 'agent-state.json');
    // Another process's agent: same state file, a different (live) pid.
    const other = await startAgentServer({ token, agentVersion: '0.1.0' });
    writeStateFile(stateFile, {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      host: '127.0.0.1',
      port: other.port,
      token,
      pid: process.ppid,
      startedAt: other.startedAt,
    });
    try {
      await expect(runAgent({ stateFile, agentVersion: '0.1.0', env })).rejects.toThrow(/already running/);
      // A stale file (dead pid) is replaced.
      writeStateFile(stateFile, {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        host: '127.0.0.1',
        port: other.port,
        token,
        pid: 2 ** 22 + 12345,
        startedAt: other.startedAt,
      });
      const agent = await runAgent({ stateFile, agentVersion: '0.1.0', env });
      await agent.stop();
    } finally {
      await other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
