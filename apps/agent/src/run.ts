import { createAgentHost } from '@ticket/agent-host';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@ticket/agent-protocol';
import { createOllamaClient, loadOllamaConfig } from '@ticket/model-provider';
import { CLASSIFY_MIN_CONFIDENCE_DEFAULT } from '@ticket/shared';
import { openTicketDatabase } from '@ticket/storage';
import { resolve } from 'node:path';
import { startAgentServer, type AgentServer } from './server.js';
import { removeStateFile, writeStateFile } from './state-file.js';
import { generateToken } from './token.js';

export interface RunAgentOptions {
  readonly stateFile: string;
  readonly agentVersion: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

/** `TICKET_DATA_DIR` is the SQLite file. The default sits next to the agent package. */
export function resolveTicketDatabasePath(env: NodeJS.ProcessEnv): string {
  const configured = env['TICKET_DATA_DIR']?.trim();
  if (configured) return resolve(configured);
  return resolve(import.meta.dirname, '..', '.data', 'tickets.db');
}

function readMinConfidence(env: NodeJS.ProcessEnv): number {
  const raw = env['CLASSIFY_MIN_CONFIDENCE']?.trim();
  if (!raw) return CLASSIFY_MIN_CONFIDENCE_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('CLASSIFY_MIN_CONFIDENCE must be a number from 0 to 1.');
  }
  return value;
}

export interface RunningAgent {
  readonly server: AgentServer;
  readonly stateFile: string;
  stop(): Promise<void>;
}

/** Starts the server with a fresh token, then publishes the state file. */
export async function runAgent(options: RunAgentOptions): Promise<RunningAgent> {
  const env = options.env ?? process.env;
  const db = openTicketDatabase(resolveTicketDatabasePath(env));
  const ollama = createOllamaClient(loadOllamaConfig(env));
  const host = createAgentHost({ db, ollama, minConfidence: readMinConfidence(env) });
  const token = generateToken();
  let server: AgentServer | undefined;
  try {
    server = await startAgentServer({
      token,
      agentVersion: options.agentVersion,
      calls: host,
      ...(options.port !== undefined && { port: options.port }),
      ...(options.log && { log: options.log }),
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
