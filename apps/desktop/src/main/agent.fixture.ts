/**
 * Test support only (never imported by the app): runs the real apps/agent service
 * from source with tsx in place of Electron's utilityProcess, and a fake Ollama.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { resolve } from 'node:path';
import { type AgentChild, type ForkAgent } from './agent-supervisor.js';

export const AGENT_SOURCE_ENTRY = resolve(import.meta.dirname, '..', '..', '..', 'agent', 'src', 'main.ts');
const AGENT_DIR = resolve(AGENT_SOURCE_ENTRY, '..', '..');

export interface ForkRecorder {
  readonly fork: ForkAgent;
  readonly children: ChildProcess[];
  /** Everything the agent children wrote, raw (not via the desktop log). */
  output(): string;
}

/** A `ForkAgent` backed by `node --import tsx <entry>`, recording the children and their output. */
export function tsxFork(): ForkRecorder {
  const children: ChildProcess[] = [];
  let output = '';
  const fork: ForkAgent = (modulePath, args, options) => {
    const child = spawn(process.execPath, ['--import', 'tsx', modulePath, ...args], {
      cwd: AGENT_DIR,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    children.push(child);
    return child as unknown as AgentChild;
  };
  return { fork, children, output: () => output };
}

/** Starts an agent the way `yarn agent:dev` does (not supervised). */
export function startForeignAgent(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', AGENT_SOURCE_ENTRY], {
    cwd: AGENT_DIR,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Timed out.');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const waitForFile = (path: string, timeoutMs?: number) => waitFor(() => existsSync(path), timeoutMs);

export function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once('exit', () => r()));
}

export interface FakeOllama {
  readonly url: string;
  /** `answer`: reply at once. `hang`: never reply (until the client gives up). */
  mode: 'answer' | 'hang';
  readonly chats: { headers: IncomingHttpHeaders; aborted: boolean; answered: boolean }[];
  close(): Promise<void>;
}

/** `/api/tags` lists one model; `/api/chat` answers billing at 0.9, or hangs. */
export async function fakeOllama(): Promise<FakeOllama> {
  const state: FakeOllama = {
    url: '',
    mode: 'answer',
    chats: [],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'test-model', size: 1 }] }));
        return;
      }
      const chat = { headers: req.headers, aborted: false, answered: false };
      state.chats.push(chat);
      res.on('close', () => {
        if (!chat.answered) chat.aborted = true;
      });
      if (state.mode === 'hang') return;
      chat.answered = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      const content = JSON.stringify({ departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.' });
      res.end(JSON.stringify({ message: { role: 'assistant', content } }));
    });
  });
  const url = await new Promise<string>((r) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      r(typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '');
    }),
  );
  Object.assign(state, {
    url,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
  return state;
}

/** `list[index]`, or a test failure if it is missing. */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`Nothing at index ${index}.`);
  return item;
}
