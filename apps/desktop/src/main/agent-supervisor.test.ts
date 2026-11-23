import { connectFromStateFile, createAgentLink, readStateFile, type AgentLink } from '@ticket/agent-client';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  at,
  exitOf,
  fakeOllama,
  startForeignAgent,
  tsxFork,
  waitFor,
  waitForFile,
  AGENT_SOURCE_ENTRY,
  type FakeOllama,
  type ForkRecorder,
} from './agent.fixture.js';
import { agentEnvironment, createAgentSupervisor, type AgentSupervisor } from './agent-supervisor.js';
import { createDesktopLog } from './desktop-log.js';
import { createIpcHandlers } from './ipc.js';
import { createTokenStore } from './token-store.js';
import { IpcChannels } from '@ticket/shared';

let dir: string;
let stateFile: string;
let ollama: FakeOllama;
let recorder: ForkRecorder;
let supervisor: AgentSupervisor | undefined;
let link: AgentLink | undefined;
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket-supervisor-'));
  stateFile = join(dir, 'agent-state.json');
  ollama = await fakeOllama();
  recorder = tsxFork();
});

afterEach(async () => {
  link?.close();
  link = undefined;
  await supervisor?.stop();
  supervisor = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const child of recorder.children) {
    child.kill('SIGKILL');
    await exitOf(child);
  }
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
});

function supervise(extra: { backoffMs?: number[] } = {}): AgentSupervisor {
  supervisor = createAgentSupervisor({
    fork: recorder.fork,
    entry: AGENT_SOURCE_ENTRY,
    stateFile,
    databaseFile: join(dir, 'tickets.db'),
    env: { ...process.env, OLLAMA_HOST: ollama.url, OLLAMA_MODEL: 'test-model' },
    parentPid: process.pid,
    appVersion: '0.0.0-test',
    log: createDesktopLog({ file: join(dir, 'desktop.log'), console: false }),
    backoffMs: extra.backoffMs ?? [100, 200, 400],
    startTimeoutMs: 30_000,
  });
  return supervisor;
}

/** The desktop's link: every new connection goes through the supervisor first. */
function linkFor(s: AgentSupervisor): AgentLink {
  link = createAgentLink({
    stateFile,
    client: { kind: 'shell', version: '0.0.0-test' },
    connect: async (path, options) => {
      await s.ensure();
      return connectFromStateFile(path, options);
    },
  });
  return link;
}

const statePid = () => {
  const read = readStateFile(stateFile);
  return read.status === 'ok' ? read.state.pid : undefined;
};

describe('agent supervisor', () => {
  it('spawns the agent when none is running', async () => {
    const s = supervise();
    await s.ensure();
    expect(recorder.children).toHaveLength(1);
    expect(s.status()).toMatchObject({ state: 'running', mode: 'spawned', reconnecting: false });
    expect(statePid()).toBe(recorder.children[0]?.pid);
    const ping = await linkFor(s).ping();
    expect(ping.pid).toBe(recorder.children[0]?.pid);
  }, 60_000);

  it('attaches to a live agent and does not start a second one', async () => {
    const foreign = startForeignAgent({
      AGENT_STATE_FILE: stateFile,
      TICKET_DATA_DIR: join(dir, 'tickets.db'),
      OLLAMA_HOST: ollama.url,
    });
    cleanups.push(async () => {
      foreign.kill('SIGKILL');
      await exitOf(foreign);
    });
    await waitForFile(stateFile, 30_000);
    const s = supervise();
    await s.ensure();
    expect(recorder.children).toHaveLength(0);
    expect(s.status()).toMatchObject({ state: 'attached', mode: 'attached' });
    expect((await linkFor(s).ping()).pid).toBe(foreign.pid);

    // Quitting the desktop leaves an attached agent running.
    link?.close();
    await s.stop();
    expect(foreign.exitCode).toBeNull();
    expect(statePid()).toBe(foreign.pid);
  }, 60_000);

  it('quit asks system.shutdown, waits, and the state file is gone', async () => {
    const s = supervise();
    await s.ensure();
    const child = at(recorder.children, 0);
    await s.stop();
    expect(child.exitCode).toBe(0); // a clean exit, not a kill
    expect(existsSync(stateFile)).toBe(false);
    expect(readFileSync(join(dir, 'desktop.log'), 'utf8')).not.toMatch(/did not stop in time/);
  }, 60_000);

  it('a crash replaces the stale state file and comes back', async () => {
    const s = supervise();
    const l = linkFor(s);
    await l.ping();
    const first = at(recorder.children, 0);
    first.kill('SIGKILL'); // a crash: no clean stop, the state file is left behind
    await exitOf(first);
    await waitFor(() => s.status().reconnecting || s.status().state === 'running');
    await waitFor(() => s.status().state === 'running' && recorder.children.length === 2, 30_000);
    const second = at(recorder.children, 1);
    expect(statePid()).toBe(second.pid);
    expect((await l.ping()).pid).toBe(second.pid);
    expect(readFileSync(join(dir, 'desktop.log'), 'utf8')).toMatch(/stopped unexpectedly/);
  }, 60_000);

  it('an agent started by the app ends when the app is killed', async () => {
    // Stand-in for the Electron main process.
    const parent = startForeignAgent({ AGENT_STATE_FILE: join(dir, 'other.json'), TICKET_DATA_DIR: join(dir, 'o.db') });
    cleanups.push(async () => {
      parent.kill('SIGKILL');
      await exitOf(parent);
    });
    const env = agentEnvironment(
      { ...process.env, OLLAMA_HOST: ollama.url },
      { stateFile, databaseFile: join(dir, 'tickets.db'), parentPid: parent.pid ?? 0 },
    );
    const child = recorder.fork(AGENT_SOURCE_ENTRY, [], { env, serviceName: 'test', stdio: 'pipe' });
    await waitForFile(stateFile, 30_000);
    parent.kill('SIGKILL'); // a forced kill of the app
    await exitOf(parent);
    await exitOf(at(recorder.children, 0));
    expect(child.pid).toBeDefined();
    expect(existsSync(stateFile)).toBe(false);
  }, 60_000);

  it('passes no secret as an argument and drops the API key from the environment', () => {
    const env = agentEnvironment(
      { API_KEY: 'k', NODE_OPTIONS: '--inspect', OLLAMA_HOST: 'http://h' },
      { stateFile: '/s', databaseFile: '/d', parentPid: 1 },
    );
    expect(env).toEqual({
      OLLAMA_HOST: 'http://h',
      AGENT_STATE_FILE: '/s',
      TICKET_DATA_DIR: '/d',
      TICKET_AGENT_PARENT_PID: '1',
    });
  });

  it('keeps runtime paths and model overrides, and drops the Ollama token', () => {
    const env = agentEnvironment(
      {
        PATH: '/bin',
        OLLAMA_HOST: 'http://h',
        OLLAMA_MODEL: 'qwen3:8b',
        CLASSIFY_MIN_CONFIDENCE: '0.8',
        OLLAMA_TOKEN: 'secret-token',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        API_KEY: 'k',
      },
      { stateFile: '/s', databaseFile: '/d', parentPid: 1 },
    );
    expect(env['PATH']).toBe('/bin');
    expect(env['OLLAMA_MODEL']).toBe('qwen3:8b');
    expect(env['CLASSIFY_MIN_CONFIDENCE']).toBe('0.8');
    expect(env['OLLAMA_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['API_KEY']).toBeUndefined();
  });

  it('stops a child that never publishes a state file', async () => {
    const exits: ((code: number | null) => void)[] = [];
    let kills = 0;
    const hung = {
      pid: 5150,
      stdout: null,
      stderr: null,
      kill() {
        kills += 1;
        for (const listener of exits.splice(0)) listener(1);
        return true;
      },
      once(event: 'spawn' | 'exit', listener: (...args: never[]) => void) {
        if (event === 'spawn') listener();
        if (event === 'exit') exits.push(listener as (code: number | null) => void);
      },
    };
    const local = createAgentSupervisor({
      fork: () => hung,
      entry: 'unused',
      stateFile,
      databaseFile: join(dir, 'tickets.db'),
      env: {},
      parentPid: 1,
      appVersion: '0',
      log: createDesktopLog({ console: false }),
      backoffMs: [60_000],
      startTimeoutMs: 40,
    });
    try {
      await expect(local.ensure()).rejects.toThrow(/did not start in time/);
      expect(kills).toBe(1);
      expect(local.childPid()).toBeUndefined();
    } finally {
      await local.stop();
    }
  });
});

describe('classify through the supervised agent', () => {
  const ticket = { externalId: 'ext-1', subject: 'Invoice 7', body: 'Please check.', channel: 'email' };

  async function setup() {
    const s = supervise();
    const l = linkFor(s);
    await s.ensure();
    await l.request('departments.create', { id: 'billing', name: 'Billing', description: 'Invoices' });
    const tokens = createTokenStore({
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      filePath: join(dir, 'token.bin'),
      platform: 'win32',
    });
    return { s, l, handlers: createIpcHandlers({ agent: l, tokens, supervisor: s }) };
  }

  it('a classify that crashed before its decision can be submitted again with the same externalId', async () => {
    const { l } = await setup();
    ollama.mode = 'hang';
    const pending = l.request('tickets.classify', ticket).catch((error: unknown) => error);
    await waitFor(() => ollama.chats.length === 1, 30_000);
    at(recorder.children, 0).kill('SIGKILL'); // the agent dies mid-classify: a ticket row, no decision
    expect(await pending).toMatchObject({ name: 'AgentClientError' });

    ollama.mode = 'answer';
    await waitFor(() => supervisor?.status().state === 'running' && recorder.children.length === 2, 30_000);
    const view = await l.request('tickets.classify', ticket);
    expect(view.decision).toMatchObject({ status: 'labeled', departmentId: 'billing' });
    // A saved decision is returned again without another model call.
    const chats = ollama.chats.length;
    expect((await l.request('tickets.classify', ticket)).id).toBe(view.id);
    expect(ollama.chats.length).toBe(chats);
    expect(await l.request('tickets.list', {})).toHaveLength(1);
  }, 90_000);

  it('cancel stops the model call, stores nothing, and the externalId can be submitted again', async () => {
    const { l, handlers } = await setup();
    ollama.mode = 'hang';
    const submit = handlers[IpcChannels.classifyTicket](ticket).catch((error: unknown) => error);
    await waitFor(() => ollama.chats.length === 1, 30_000);

    expect(await handlers[IpcChannels.cancelClassify]({ externalId: 'ext-1' })).toEqual({ cancelled: true });
    expect(await submit).toMatchObject({ code: 'cancelled' });
    // The cancel reached the Ollama request.
    await waitFor(() => at(ollama.chats, 0).aborted, 10_000);
    expect(at(ollama.chats, 0).answered).toBe(false);
    expect(await l.request('tickets.list', {})).toEqual([]);

    ollama.mode = 'answer';
    const again = await handlers[IpcChannels.classifyTicket](ticket);
    expect(again).toMatchObject({ externalId: 'ext-1', decision: { status: 'labeled' } });

    // A cancel after the decision is stored changes nothing.
    expect(await handlers[IpcChannels.cancelClassify]({ externalId: 'ext-1' })).toEqual({ cancelled: false });
    expect(await l.request('tickets.list', {})).toHaveLength(1);
  }, 90_000);
});
