import { type AgentPing } from '@ticket/shared';
import {
  type RequestParamsInput,
  type RequestResult,
} from '@ticket/agent-protocol';
import { AgentClientError, type AgentClient, type ClientIdentity, type ClientMethodName } from './client.js';
import {
  connectFromStateFile,
  type ConnectFromStateFileOptions,
  type StateFileConnection,
} from './connect.js';

export const AGENT_CONNECT_TIMEOUT_MS = 5_000;
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * One lazy connection to the agent, shared by a process (Electron main or the API).
 * It connects on first use through the state file and again after the connection
 * is lost, so either side may start first or restart.
 */
export interface AgentLink {
  request<M extends ClientMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    options?: { readonly timeoutMs?: number },
  ): Promise<RequestResult<M>>;
  /** `system.ping`. Rejects with an `AgentClientError` when the agent is not reachable. */
  ping(options?: { readonly timeoutMs?: number }): Promise<AgentPing>;
  close(): void;
}

export interface AgentLinkOptions {
  readonly stateFile: string;
  readonly client: ClientIdentity;
  readonly connectTimeoutMs?: number;
  /** Tests: replace the state-file lookup. */
  readonly connect?: (
    path: string,
    options: ConnectFromStateFileOptions,
  ) => Promise<StateFileConnection>;
  /** Never receives the token. */
  readonly log?: (message: string) => void;
  /**
   * Runs once per new connection, before any other request uses it. Electron main
   * uses it to hand the agent its in-memory access token again after an agent restart.
   */
  readonly onConnect?: (client: AgentClient) => Promise<void>;
}

export function createAgentLink(options: AgentLinkOptions): AgentLink {
  const connect = options.connect ?? connectFromStateFile;
  const log = options.log ?? (() => undefined);
  let client: AgentClient | undefined;
  let connecting: Promise<AgentClient> | undefined;
  let closed = false;

  async function open(): Promise<AgentClient> {
    if (closed) throw new AgentClientError('connection_closed', 'The agent link is closed.');
    const connection = await connect(options.stateFile, {
      client: options.client,
      timeoutMs: options.connectTimeoutMs ?? AGENT_CONNECT_TIMEOUT_MS,
    });
    const next = connection.client;
    next.onClose((error) => {
      if (client === next) client = undefined;
      if (!closed) log(`Agent connection closed: ${error.message}`);
    });
    if (closed) {
      next.close();
      throw new AgentClientError('connection_closed', 'The agent link is closed.');
    }
    if (options.onConnect) {
      try {
        await options.onConnect(next);
      } catch (error) {
        log('The connect hook failed; the connection is used without it.');
        void error;
      }
    }
    client = next;
    log(`Connected to the agent on ${connection.state.host}:${connection.state.port}.`);
    return next;
  }

  function current(): Promise<AgentClient> {
    if (client && !client.closed) return Promise.resolve(client);
    connecting ??= open().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  const request: AgentLink['request'] = async (method, params, requestOptions) => {
    const c = await current();
    return c.request(method, params, {
      timeoutMs: requestOptions?.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS,
    });
  };

  return {
    request,
    ping: (pingOptions) => request('system.ping', {}, pingOptions),
    close() {
      closed = true;
      client?.close();
      client = undefined;
    },
  };
}
