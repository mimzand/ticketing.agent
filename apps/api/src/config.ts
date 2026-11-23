import { resolve } from 'node:path';
import { resolveApiKey } from './security.js';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly agentStateFile: string;
  readonly apiKey: string;
  /** True when this process generated the key because API_KEY was unset. */
  readonly apiKeyGenerated: boolean;
}

export const DEFAULT_API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 8787;

/** The agent's default state file: `apps/agent/.agent-data/agent-state.json`. */
export const DEFAULT_AGENT_STATE_FILE = resolve(
  import.meta.dirname,
  '..',
  '..',
  'agent',
  '.agent-data',
  'agent-state.json',
);

/** API_HOST, API_PORT, AGENT_STATE_FILE. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const rawPort = env['API_PORT']?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_API_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('API_PORT must be a port number between 1 and 65535.');
  }
  const stateFile = env['AGENT_STATE_FILE']?.trim();
  const host = env['API_HOST']?.trim() || DEFAULT_API_HOST;
  const apiKey = resolveApiKey(env, host);
  return {
    host,
    port,
    agentStateFile: stateFile ? resolve(stateFile) : DEFAULT_AGENT_STATE_FILE,
    apiKey: apiKey.key,
    apiKeyGenerated: apiKey.generated,
  };
}
