import {
  AGENT_LOOPBACK_HOST,
  encodeFrame,
  FrameDecoder,
  parseResult,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  UNATTRIBUTED_ERROR_METHOD,
  type ClientKind,
  type Envelope,
  type HelloAck,
  type MethodName,
  type ProtocolErrorCode,
  type RequestParamsInput,
  type RequestResult,
} from '@ticket/agent-protocol';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;

export type AgentClientErrorCode =
  | ProtocolErrorCode
  /** No state file, or it names a process that is not running. */
  | 'not_running'
  /** The state file does not match AgentStateFileSchema (e.g. a host other than 127.0.0.1). */
  | 'state_file_invalid'
  | 'connect_failed'
  | 'connection_closed';

/** An `error` envelope from the agent, or a local failure. Never carries the token. */
export class AgentClientError extends Error {
  constructor(
    readonly code: AgentClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentClientError';
  }
}

export interface ClientIdentity {
  readonly kind: ClientKind;
  readonly version: string;
}

export interface AgentClientOptions {
  readonly port: number;
  readonly token: string;
  readonly client: ClientIdentity;
  /** Limit for the TCP connect, the handshake, and each request (default 10 s). */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  /**
   * Cancels the request: it rejects at once with `cancelled`, and the agent is sent
   * `system.cancel` so it stops the work (for a classify, the Ollama request).
   */
  readonly signal?: AbortSignal;
}

/** Methods a client may call after the handshake. */
export type ClientMethodName = Exclude<MethodName, 'system.hello'>;

export interface AgentClient {
  readonly ack: HelloAck;
  readonly closed: boolean;
  request<M extends ClientMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    options?: RequestOptions,
  ): Promise<RequestResult<M>>;
  /** Called once when the connection ends for any reason, including `close()`. */
  onClose(listener: (error: AgentClientError) => void): void;
  close(): void;
}

interface Pending {
  readonly method: MethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function openSocket(port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // The host is fixed: the client never dials anything but loopback.
    const socket = connect({ host: AGENT_LOOPBACK_HOST, port });
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new AgentClientError('connect_failed', message));
    };
    const timer = setTimeout(
      () => fail(`Connecting to ${AGENT_LOOPBACK_HOST}:${port} timed out.`),
      timeoutMs,
    );
    socket.once('error', (error: NodeJS.ErrnoException) =>
      fail(`Cannot connect to ${AGENT_LOOPBACK_HOST}:${port} (${error.code ?? 'error'}).`),
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

/** Connects to the agent on 127.0.0.1 and completes the `system.hello` handshake. */
export async function connectAgent(options: AgentClientOptions): Promise<AgentClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await openSocket(options.port, timeoutMs);

  const decoder = new FrameDecoder();
  const pending = new Map<string, Pending>();
  const closeListeners: ((error: AgentClientError) => void)[] = [];
  let closeReason: AgentClientError | null = null;

  const failAll = (error: AgentClientError) => {
    closeReason ??= error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  socket.on('data', (chunk: Buffer) => {
    for (const result of decoder.push(chunk)) {
      if (!result.ok) {
        failAll(new AgentClientError(result.error.code, result.error.message));
        socket.destroy();
        return;
      }
      const envelope = result.value;
      if (envelope.kind === 'req') continue; // No reverse calls in v1.
      const p = pending.get(envelope.id);
      if (!p) {
        // An unattributed error (bad frame, handshake timeout) ends the connection. A late
        // answer to a request this side already gave up on (timeout, cancel) is ignored.
        if (envelope.kind === 'error' && envelope.method === UNATTRIBUTED_ERROR_METHOD) {
          failAll(new AgentClientError(envelope.payload.code, envelope.payload.message));
        }
        continue;
      }
      pending.delete(envelope.id);
      clearTimeout(p.timer);
      if (envelope.kind === 'error') {
        p.reject(new AgentClientError(envelope.payload.code, envelope.payload.message));
        continue;
      }
      const checked = parseResult(p.method, envelope.payload);
      if (checked.ok) p.resolve(checked.value);
      else p.reject(new AgentClientError(checked.error.code, checked.error.message));
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    failAll(new AgentClientError('connection_closed', 'The agent closed the connection.'));
    const reason = closeReason ?? new AgentClientError('connection_closed', 'Closed.');
    for (const listener of closeListeners.splice(0)) listener(reason);
  });

  const send = <M extends MethodName>(
    method: M,
    params: unknown,
    requestTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RequestResult<M>> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(closeReason ?? new AgentClientError('connection_closed', 'The connection is closed.'));
        return;
      }
      if (signal?.aborted) {
        reject(new AgentClientError('cancelled', `${method} was cancelled.`));
        return;
      }
      const id = randomUUID();
      const onAbort = () => {
        if (!pending.has(id)) return;
        settle(id);
        reject(new AgentClientError('cancelled', `${method} was cancelled.`));
        // Tell the agent; its answer (and the cancelled request's own error) is ignored.
        if (!socket.destroyed) {
          const cancel: Envelope = { id: randomUUID(), kind: 'req', method: 'system.cancel', payload: { id } };
          socket.write(encodeFrame(cancel));
        }
      };
      const timer = setTimeout(() => {
        settle(id);
        reject(new AgentClientError('timeout', `${method} timed out.`));
      }, requestTimeoutMs);
      const settle = (key: string) => {
        pending.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as RequestResult<M>);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const envelope: Envelope = { id, kind: 'req', method, payload: params };
      socket.write(encodeFrame(envelope));
    });

  try {
    const ack = await send(
      'system.hello',
      {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        token: options.token,
        client: options.client,
      },
      timeoutMs,
    );
    return {
      ack,
      get closed() {
        return socket.destroyed;
      },
      request: (method, params, requestOptions = {}) =>
        send(method, params, requestOptions.timeoutMs ?? timeoutMs, requestOptions.signal),
      onClose: (listener) => {
        if (socket.destroyed) {
          listener(closeReason ?? new AgentClientError('connection_closed', 'Closed.'));
        } else {
          closeListeners.push(listener);
        }
      },
      close: () => {
        closeReason ??= new AgentClientError('connection_closed', 'Closed by the client.');
        socket.destroy();
      },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
