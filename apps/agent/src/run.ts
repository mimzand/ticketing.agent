import { createAgentHost } from '@ticket/agent-host';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@ticket/agent-protocol';
import { openTicketDatabase } from '@ticket/storage';
import { resolve } from 'node:path';
import { startAgentServer, type AgentServer } from './server.js';
import { findLiveAgent, removeStateFile, writeStateFile } from './state-file.js';
import { generateToken } from './token.js';

export interface RunAgentOptions {
  readonly stateFile: string;
  readonly agentVersion: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /** `system.shutdown` from the desktop shell. */
  readonly onShutdown?: () => void;
}

/** `TICKET_DATA_DIR` is the SQLite file. The default sits next to the agent package. */
export function resolveTicketDatabasePath(env: NodeJS.ProcessEnv): string {
  const configured = env['TICKET_DATA_DIR']?.trim();
  if (configured) return resolve(configured);
  return resolve(import.meta.dirname, '..', '.data', 'tickets.db');
}

export interface RunningAgent {
  readonly server: AgentServer;
  readonly stateFile: string;
  stop(): Promise<void>;
}

/** Starts the server with a fresh token, then publishes the state file. */
export async function runAgent(options: RunAgentOptions): Promise<RunningAgent> {
  const env = options.env ?? process.env;
  // One SQLite writer: never start next to a live agent for the same state file.
  // A stale file (its agent crashed) is simply replaced below.
  const live = await findLiveAgent(options.stateFile);
  if (live) {
    throw new Error(
      `Another agent (pid ${live.pid}) is already running for this state file and owns the database. Use it, or stop it first.`,
    );
  }
  const databasePath = resolveTicketDatabasePath(env);
  const db = openTicketDatabase(databasePath);
  // Settings (saved in SQLite, overridable by OLLAMA_HOST, OLLAMA_MODEL,
  // CLASSIFY_MIN_CONFIDENCE) are resolved by the host on every call.
  // One compact, secret-free JSON line per stored classify outcome (ids, counts,
  // codes; never ticket text, email, rationale, quote, model output, token, or URL).
  const log = options.log;
  const host = createAgentHost({
    db,
    env,
    databasePath,
    ...(log && { onDecisionEvent: (event) => log(`Decision ${JSON.stringify(event)}`) }),
  });
  const token = generateToken();
  let server: AgentServer | undefined;
  try {
    server = await startAgentServer({
      token,
      agentVersion: options.agentVersion,
      calls: host,
      ...(options.port !== undefined && { port: options.port }),
      ...(options.log && { log: options.log }),
      ...(options.onShutdown && { onShutdown: options.onShutdown }),
    });
    writeStateFile(options.stateFile, {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      host: server.host,
      port: server.port,
      token,
      pid: process.pid,
      startedAt: server.startedAt,
    });
  } catch (error) {
    db.close();
    await server?.close();
    throw error;
  }

  let stopped = false;
  return {
    server,
    stateFile: options.stateFile,
    async stop() {
      if (stopped) return;
      stopped = true;
      removeStateFile(options.stateFile, token);
      await server.close();
      db.close();
    },
  };
}
