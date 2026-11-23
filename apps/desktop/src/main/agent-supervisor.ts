import {
  connectFromStateFile,
  isProcessAlive,
  readStateFile,
  type ConnectFromStateFileOptions,
  type StateFileConnection,
} from '@ticket/agent-client';
import { type AgentMode } from '@ticket/shared';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DesktopLog } from './desktop-log.js';

/*
 * Electron main supervises the agent service.
 *
 * - If the state file names a live agent on 127.0.0.1 (for example `yarn agent:dev` or
 *   `yarn api:up`), the desktop attaches to it and starts nothing.
 * - Otherwise it forks exactly one child with Electron's utilityProcess: the built
 *   apps/agent service (`out/agent/main.js`). No shell, no exec, no arguments at all.
 *   Paths go in the environment; the agent generates its own token and writes it only
 *   to the state file. The child inherits the runtime path and the Ollama host, model,
 *   and confidence overrides. It does not inherit the API key, the Ollama token, or
 *   any other secret. The shell hands the Ollama token over the loopback after connect.
 * - A crash removes the stale state file and restarts the agent with a short, bounded
 *   backoff. Quit asks `system.shutdown`, waits, and then the state file is gone.
 */

/** What the supervisor needs from Electron's `UtilityProcess` (or a Node child in tests). */
export interface AgentChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

/** Electron: `utilityProcess.fork`, passed through unchanged by index.ts. */
export type ForkAgent = (
  modulePath: string,
  args: string[],
  options: { readonly env: Record<string, string>; readonly serviceName: string; readonly stdio: 'pipe' },
) => AgentChild;

/** The built agent inside the desktop app. */
export const agentEntryPath = (appPath: string): string => join(appPath, 'out', 'agent', 'main.js');

/** Restart delays after a crash. After the last one the supervisor gives up. */
export const RESTART_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const;
/** A child that ran this long counts as healthy: the backoff starts over. */
export const STABLE_RUN_MS = 30_000;
/** Cold start loads ADK. Past this, the child is stopped instead of left holding the database. */
export const AGENT_START_TIMEOUT_MS = 60_000;
export const AGENT_STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 50;

/**
 * Names the child may inherit, compared case-insensitively. Anything else — API keys,
 * OLLAMA_TOKEN, cloud credentials — stays in the parent. The Ollama token reaches the
 * agent later, over the loopback, from the shell's safeStorage copy.
 */
const INHERITED_ENV = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'systemdrive',
  'temp',
  'tmp',
  'tmpdir',
  'userprofile',
  'homedrive',
  'homepath',
  'appdata',
  'localappdata',
  'home',
  'user',
  'logname',
  'lang',
  'lc_all',
  'tz',
  'node_env',
  'ollama_host',
  'ollama_model',
  'classify_min_confidence',
]);

/**
 * The child's environment: just enough to run, plus OLLAMA_HOST, OLLAMA_MODEL, and
 * CLASSIFY_MIN_CONFIDENCE so those still override saved settings. Then the fixed
 * paths and the parent pid for the agent's watchdog.
 */
export function agentEnvironment(
  env: NodeJS.ProcessEnv,
  paths: { readonly stateFile: string; readonly databaseFile: string; readonly parentPid: number },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !INHERITED_ENV.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out['AGENT_STATE_FILE'] = paths.stateFile;
  out['TICKET_DATA_DIR'] = paths.databaseFile;
  out['TICKET_AGENT_PARENT_PID'] = String(paths.parentPid);
  return out;
}

export type SupervisorState = 'idle' | 'attached' | 'starting' | 'running' | 'reconnecting' | 'failed' | 'stopped';

export interface SupervisorStatus {
  readonly state: SupervisorState;
  readonly mode: AgentMode | null;
  /** The app's agent stopped unexpectedly and is being restarted. */
  readonly reconnecting: boolean;
}

export interface AgentSupervisorDeps {
  readonly fork: ForkAgent;
  readonly entry: string;
  readonly stateFile: string;
  readonly databaseFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly parentPid: number;
  readonly appVersion: string;
  readonly log: DesktopLog;
  readonly connect?: (path: string, options: ConnectFromStateFileOptions) => Promise<StateFileConnection>;
  readonly backoffMs?: readonly number[];
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Called on every state change (main forwards it to the window). */
  readonly onStatus?: (status: SupervisorStatus) => void;
}

export interface AgentSupervisor {
  readonly stateFile: string;
  /**
   * Makes sure an agent is there: attaches to a live one, or starts (or waits for the
   * restart of) the app's own. Rejects when the agent cannot be started.
   */
  ensure(): Promise<void>;
  status(): SupervisorStatus;
  /** The pid of the child this app started, if it is running. */
  childPid(): number | undefined;
  /**
   * Quit: `system.shutdown` to the app's own agent, wait, kill if it does not stop,
   * then make sure the state file is gone. An attached agent is left running.
   * Never throws. Idempotent.
   */
  stop(): Promise<void>;
}

export function createAgentSupervisor(deps: AgentSupervisorDeps): AgentSupervisor {
  const { log, stateFile } = deps;
  const connect = deps.connect ?? connectFromStateFile;
  const backoff = deps.backoffMs ?? RESTART_BACKOFF_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? AGENT_STOP_TIMEOUT_MS;

  let state: SupervisorState = 'idle';
  const statusOf = (): SupervisorStatus => ({
    state,
    mode: state === 'attached' ? 'attached' : state === 'running' ? 'spawned' : null,
    reconnecting: state === 'reconnecting',
  });
  const setState = (next: SupervisorState) => {
    if (next === state) return;
    state = next;
    try {
      deps.onStatus?.(statusOf());
    } catch {
      // A listener must not break supervision.
    }
  };
  let child: AgentChild | undefined;
  let exited: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let restartWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let crashes = 0;
  let stopping: Promise<void> | undefined;

  /** A live agent that another process started for this state file. */
  async function liveForeignAgent(): Promise<boolean> {
    const read = readStateFile(stateFile);
    if (read.status !== 'ok') return false;
    if (child?.pid !== undefined && read.state.pid === child.pid) return false;
    if (!isProcessAlive(read.state.pid)) return false;
    try {
      const connection = await connect(stateFile, {
        client: { kind: 'shell', version: deps.appVersion },
        timeoutMs: 2_000,
      });
      connection.client.close();
      return true;
    } catch {
      return false;
    }
  }

  /** Removes the state file if it is stale: invalid, its pid is gone, or it names `pid`. */
  function clearStaleStateFile(pid?: number): void {
    const read = readStateFile(stateFile);
    if (read.status === 'missing') return;
    if (read.status === 'invalid' || read.state.pid === pid || !isProcessAlive(read.state.pid)) {
      rmSync(stateFile, { force: true });
      log.info('Removed a stale agent state file.');
    }
  }

  function forward(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
    if (!stream) return;
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) write(line);
    });
  }

  async function waitForStateFile(pid: number | undefined, hasExited: () => boolean): Promise<void> {
    const end = Date.now() + (deps.startTimeoutMs ?? AGENT_START_TIMEOUT_MS);
    for (;;) {
      if (hasExited()) throw new Error('The agent stopped during startup.');
      const read = readStateFile(stateFile);
      if (read.status === 'ok' && (pid === undefined || read.state.pid === pid)) return;
      if (Date.now() > end) throw new Error('The agent did not start in time.');
      await sleep(POLL_MS);
    }
  }

  async function spawn(): Promise<void> {
    clearStaleStateFile();
    setState('starting');
    const forked = deps.fork(
      deps.entry,
      [],
      {
        env: agentEnvironment(deps.env, {
          stateFile,
          databaseFile: deps.databaseFile,
          parentPid: deps.parentPid,
        }),
        serviceName: 'Ticketing Agent',
        stdio: 'pipe',
      },
    );
    child = forked;
    let hasExited = false;
    const startedAt = Date.now();
    exited = new Promise<void>((resolve) =>
      forked.once('exit', (code) => {
        hasExited = true;
        resolve();
        onExit(forked, code, Date.now() - startedAt);
      }),
    );
    forward(forked.stdout, (line) => log.info(`[agent] ${line.replace(/^\[agent\]\s*/, '')}`));
    forward(forked.stderr, (line) => log.warn(`[agent] ${line.replace(/^\[agent\]\s*/, '')}`));
    await new Promise<void>((resolve) => {
      if (forked.pid !== undefined) resolve();
      else forked.once('spawn', () => resolve());
      void exited?.then(() => resolve());
    });
    try {
      await waitForStateFile(forked.pid, () => hasExited);
      if (child === forked) setState('running');
      log.info(`Agent started by the desktop (pid ${forked.pid ?? '?'}).`);
    } catch (error) {
      // A child that never publishes a state file must not keep the database.
      // Leaving it alive makes the next start refuse, because it still looks live.
      if (!hasExited && child === forked) {
        log.warn('The agent did not become ready; stopping it.');
        forked.kill();
        const stopped = await settlesWithin(exited, stopTimeoutMs);
        if (!stopped && child === forked) {
          child = undefined;
          setState('failed');
          log.warn('The agent kept running after a failed start.');
        }
      }
      throw error;
    }
  }

  function onExit(forked: AgentChild, code: number | null, ranMs: number): void {
    if (child !== forked) return;
    child = undefined;
    if (stopping || state === 'stopped') return;
    // A crash: the state file names a dead pid now. Replace it on the next start.
    clearStaleStateFile(forked.pid);
    if (ranMs >= STABLE_RUN_MS) crashes = 0;
    const delay = backoff[crashes];
    crashes += 1;
    if (delay === undefined) {
      setState('failed');
      log.warn(`The agent stopped (code ${code ?? 'none'}) and did not stay up; giving up.`);
      flushRestartWaiters(new Error('The agent keeps stopping. Restart the app.'));
      return;
    }
    setState('reconnecting');
    log.warn(`The agent stopped unexpectedly (code ${code ?? 'none'}); restarting in ${delay} ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (stopping) return;
      starting = spawn()
        .then(() => flushRestartWaiters())
        .catch((error: unknown) => {
          log.warn(`Restarting the agent failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          // A child that exited already scheduled the next attempt. A fork that threw did not.
          if (!child && !restartTimer && !stopping && state !== 'failed') {
            const none = { pid: undefined } as AgentChild;
            child = none;
            onExit(none, null, 0);
          }
        })
        .finally(() => {
          starting = undefined;
        });
    }, delay);
  }

  function flushRestartWaiters(error?: Error): void {
    const waiters = restartWaiters;
    restartWaiters = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  return {
    stateFile,

    async ensure() {
      if (stopping || state === 'stopped') throw new Error('The app is quitting.');
      if (state === 'failed') throw new Error('The agent keeps stopping. Restart the app.');
      if (state === 'running' && child) return;
      if (starting) return starting;
      if (state === 'reconnecting') {
        return new Promise<void>((resolve, reject) => restartWaiters.push({ resolve, reject }));
      }
      if (await liveForeignAgent()) {
        if (state !== 'attached') log.info('Attached to an agent that was already running.');
        setState('attached');
        return;
      }
      starting = spawn().finally(() => {
        starting = undefined;
      });
      return starting;
    },

    status: statusOf,

    childPid: () => child?.pid,

    stop() {
      stopping ??= (async () => {
        clearTimeout(restartTimer);
        flushRestartWaiters(new Error('The app is quitting.'));
        const running = child;
        const wasAttached = state === 'attached';
        setState('stopped');
        if (wasAttached || !running) return;
        let accepted = false;
        try {
          const connection = await connect(stateFile, {
            client: { kind: 'shell', version: deps.appVersion },
            timeoutMs: 2_000,
          });
          try {
            await connection.client.request('system.shutdown', {}, { timeoutMs: 2_000 });
            accepted = true;
          } finally {
            connection.client.close();
          }
        } catch {
          // Not reachable: fall through to the kill below.
        }
        if (!(await settlesWithin(exited, accepted ? stopTimeoutMs : 0))) {
          log.warn('The agent did not stop in time; ending it.');
          running.kill();
          await settlesWithin(exited, stopTimeoutMs);
        }
        // A clean stop removed the file already; a killed agent leaves it behind.
        clearStaleStateFile(running.pid);
        log.info('Agent stopped.');
      })().catch(() => {
        log.warn('Stopping the agent failed.');
      });
      return stopping;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settlesWithin(promise: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (!promise) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
