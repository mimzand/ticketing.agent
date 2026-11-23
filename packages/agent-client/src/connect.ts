import { type AgentStateFile } from '@ticket/agent-protocol';
import {
  AgentClientError,
  connectAgent,
  type AgentClient,
  type ClientIdentity,
} from './client.js';
import { isProcessAlive, readStateFile } from './state-file.js';

export interface ConnectFromStateFileOptions {
  readonly client: ClientIdentity;
  readonly timeoutMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface StateFileConnection {
  readonly client: AgentClient;
  /** The state file without its token. */
  readonly state: Omit<AgentStateFile, 'token'>;
}

/**
 * Finds the agent through its state file and connects. Fails with an
 * `AgentClientError` when the file is missing, invalid (including a non-loopback
 * host), stale, or the agent does not answer. Messages never include the token.
 */
export async function connectFromStateFile(
  path: string,
  options: ConnectFromStateFileOptions,
): Promise<StateFileConnection> {
  const read = readStateFile(path);
  if (read.status === 'missing') {
    throw new AgentClientError('not_running', 'No agent state file. Is the agent running?');
  }
  if (read.status === 'invalid') {
    throw new AgentClientError(
      'state_file_invalid',
      'The agent state file is not valid (it must name 127.0.0.1, a port, and a token).',
    );
  }
  const { token, ...state } = read.state;
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (!alive(state.pid)) {
    throw new AgentClientError('not_running', `The agent state file is stale (pid ${state.pid}).`);
  }
  const client = await connectAgent({
    port: state.port,
    token,
    client: options.client,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  return { client, state };
}
