import {
  type ClassifyTicket,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type CreateDepartment,
  type DeleteDepartment,
  type DeleteDepartmentResult,
  type Department,
  type ModelHealth,
  type ModelList,
  type OverrideTicket,
  type SettingsPatch,
  type SettingsView,
  type StorageInfo,
  type TicketView,
  type TokenState,
  type UpdateDepartment,
} from '@ticket/shared';
import {
  AGENT_LOOPBACK_HOST,
  AgentTokenSchema,
  encodeFrame,
  FrameDecoder,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  parseHello,
  parseRequest,
  parseResult,
  protocolError,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  UNATTRIBUTED_ERROR_METHOD,
  type Envelope,
  type HelloAck,
  type MethodName,
  type ClientKind,
  type ParsedRequest,
  type ProtocolError,
  type ProtocolErrorCode,
} from '@ticket/agent-protocol';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { tokensEqual } from './token.js';

/** Frame limit before the handshake. A hello is a few hundred bytes. */
export const HANDSHAKE_MAX_FRAME_BYTES = 16 * 1024;
/** How long a rejected client gets to read the error before the socket is destroyed. */
const CLOSE_GRACE_MS = 1_000;
const MAX_CONNECTIONS = 16;

/** Domain operations the protocol server forwards after the handshake. */
export interface AgentCalls {
  listDepartments(): readonly Department[] | Promise<readonly Department[]>;
  createDepartment(input: CreateDepartment): Department | Promise<Department>;
  updateDepartment(input: UpdateDepartment): Department | Promise<Department>;
  deleteDepartment(input: DeleteDepartment): DeleteDepartmentResult | Promise<DeleteDepartmentResult>;
  /** `signal` aborts when the client cancels the request or disconnects. */
  classify(input: ClassifyTicket, signal?: AbortSignal): Promise<TicketView>;
  listTickets(): readonly TicketView[] | Promise<readonly TicketView[]>;
  override(input: OverrideTicket): TicketView | Promise<TicketView>;
  modelHealth(): Promise<ModelHealth>;
  getSettings(): SettingsView | Promise<SettingsView>;
  updateSettings(patch: SettingsPatch): SettingsView | Promise<SettingsView>;
  setToken(token: string | null): TokenState | Promise<TokenState>;
  testConnection(input: ConnectionTestRequest): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelList>;
  storageInfo(): StorageInfo | Promise<StorageInfo>;
}

/** HostError codes that travel as protocol codes; anything else is `bad_request`. */
const HOST_ERROR_CODES: readonly ProtocolErrorCode[] = ['bad_request', 'not_found', 'conflict', 'cancelled'];

export interface AgentServerOptions {
  /** Token clients must present (AgentTokenSchema). */
  readonly token: string;
  /** 0 (default) picks an ephemeral port. */
  readonly port?: number;
  readonly agentVersion: string;
  /** Tests only; defaults to HANDSHAKE_TIMEOUT_MS (5 s). */
  readonly handshakeTimeoutMs?: number;
  /** Absent only in handshake tests. Ticket methods then answer `internal`. */
  readonly calls?: AgentCalls;
  /**
   * `system.shutdown` from the desktop shell: called after the reply is sent. Without
   * it the method answers `forbidden`.
   */
  readonly onShutdown?: () => void;
  /** Never receives the token. */
  readonly log?: (message: string) => void;
}

export interface AgentServer {
  readonly host: typeof AGENT_LOOPBACK_HOST;
  readonly port: number;
  readonly startedAt: string;
  close(): Promise<void>;
}

/** Starts the protocol server on 127.0.0.1 only. */
export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  if (!AgentTokenSchema.safeParse(options.token).success) {
    throw new Error('The agent token does not meet AgentTokenSchema.');
  }
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const sockets = new Set<Socket>();
  const ctx: ConnectionContext = {
    token: options.token,
    agentVersion: options.agentVersion,
    calls: options.calls,
    onShutdown: options.onShutdown,
    startedAt,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    log,
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, ctx);
  });
  server.maxConnections = MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: AGENT_LOOPBACK_HOST, port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The agent server has no TCP address.');
  }

  return {
    host: AGENT_LOOPBACK_HOST,
    port: address.port,
    startedAt,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

interface ConnectionContext {
  readonly token: string;
  readonly agentVersion: string;
  readonly calls: AgentCalls | undefined;
  readonly onShutdown: (() => void) | undefined;
  readonly startedAt: string;
  readonly handshakeTimeoutMs: number;
  readonly log: (message: string) => void;
}

function serveConnection(socket: Socket, ctx: ConnectionContext): void {
  const decoder = new FrameDecoder(HANDSHAKE_MAX_FRAME_BYTES);
  let authenticated = false;
  let clientKind: ClientKind | undefined;
  let closing = false;
  /** Requests of this connection that can be cancelled, by message id. */
  const inFlight = new Map<string, AbortController>();

  const send = (envelope: Envelope) => {
    if (!socket.destroyed) socket.write(encodeFrame(envelope));
  };
  const sendError = (id: string, method: string, error: ProtocolError) =>
    send({ id, kind: 'error', method, payload: error });

  /** Sends a final error, then closes. Used for every handshake and framing failure. */
  const reject = (id: string, method: string, error: ProtocolError) => {
    if (closing) return;
    closing = true;
    clearTimeout(handshakeTimer);
    ctx.log(`Connection rejected: ${error.code}.`);
    if (!socket.destroyed) socket.end(encodeFrame({ id, kind: 'error', method, payload: error }));
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  };

  const handshakeTimer = setTimeout(
    () =>
      reject(
        randomUUID(),
        UNATTRIBUTED_ERROR_METHOD,
        protocolError('unauthorized', 'Handshake timed out.'),
      ),
    ctx.handshakeTimeoutMs,
  );
  handshakeTimer.unref();

  const reply = (id: string, method: MethodName, result: unknown) => {
    const checked = parseResult(method, result);
    if (!checked.ok) {
      ctx.log(`Refusing to send an invalid ${method} result.`);
      return sendError(id, method, protocolError('internal', 'Invalid result.'));
    }
    send({ id, kind: 'res', method, payload: checked.value });
  };

  const handshake = (envelope: Envelope) => {
    const hello = parseHello(envelope);
    if (!hello.ok) return reject(envelope.id, envelope.method, hello.error);
    if (!tokensEqual(hello.value.hello.token, ctx.token)) {
      return reject(envelope.id, envelope.method, protocolError('unauthorized', 'Invalid token.'));
    }
    clearTimeout(handshakeTimer);
    authenticated = true;
    decoder.maxFrameBytes = MAX_FRAME_BYTES;
    const ack: HelloAck = {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      agent: { pid: process.pid, version: ctx.agentVersion, startedAt: ctx.startedAt },
    };
    reply(hello.value.id, 'system.hello', ack);
    clientKind = hello.value.hello.client.kind;
    ctx.log(`Client authenticated (${clientKind}).`);
  };

  const dispatch = (request: ParsedRequest) => {
    void (async () => {
      try {
        switch (request.method) {
          case 'system.ping':
            return reply(request.id, request.method, {
              pid: process.pid,
              version: ctx.agentVersion,
              protocolVersion: PROTOCOL_VERSION,
            });
          case 'system.hello':
            return sendError(
              request.id,
              request.method,
              protocolError('bad_request', 'Already authenticated.'),
            );
          case 'model.health':
            return reply(request.id, request.method, await requireCalls().modelHealth());
          case 'departments.list':
            return reply(request.id, request.method, await requireCalls().listDepartments());
          case 'departments.create':
            return reply(request.id, request.method, await requireCalls().createDepartment(request.params));
          case 'tickets.classify': {
            const controller = new AbortController();
            inFlight.set(request.id, controller);
            try {
              return reply(request.id, request.method, await requireCalls().classify(request.params, controller.signal));
            } finally {
              inFlight.delete(request.id);
            }
          }
          case 'system.cancel': {
            const target = inFlight.get(request.params.id);
            target?.abort();
            return reply(request.id, request.method, { cancelled: target !== undefined });
          }
          case 'system.shutdown':
            // Only the desktop shell that supervises the agent may stop it.
            if (clientKind !== 'shell' || !ctx.onShutdown) {
              return sendError(
                request.id,
                request.method,
                protocolError('forbidden', 'Only the desktop shell can stop the agent.'),
              );
            }
            ctx.log('Shutdown requested by the desktop shell.');
            reply(request.id, request.method, null);
            setImmediate(ctx.onShutdown);
            return undefined;
          case 'tickets.list':
            return reply(request.id, request.method, await requireCalls().listTickets());
          case 'tickets.override':
            return reply(request.id, request.method, await requireCalls().override(request.params));
          case 'departments.update':
            return reply(request.id, request.method, await requireCalls().updateDepartment(request.params));
          case 'departments.delete':
            return reply(request.id, request.method, await requireCalls().deleteDepartment(request.params));
          case 'settings.get':
            return reply(request.id, request.method, await requireCalls().getSettings());
          case 'settings.update':
            return reply(request.id, request.method, await requireCalls().updateSettings(request.params));
          case 'settings.setToken':
            // Only the desktop shell (which holds the safeStorage copy) may set the token.
            // The HTTP API connects as `cli` and can never pass one through.
            if (clientKind !== 'shell') {
              return sendError(
                request.id,
                request.method,
                protocolError('forbidden', 'Only the desktop shell can set the access token.'),
              );
            }
            return reply(request.id, request.method, await requireCalls().setToken(request.params.token));
          case 'settings.testConnection':
            return reply(request.id, request.method, await requireCalls().testConnection(request.params));
          case 'models.list':
            return reply(request.id, request.method, await requireCalls().listModels());
          case 'storage.info':
            return reply(request.id, request.method, await requireCalls().storageInfo());
          default:
            return undefined;
        }
      } catch (error) {
        const host = error instanceof Error && error.name === 'HostError';
        const hostCode = host ? (error as Error & { code?: unknown }).code : undefined;
        const code: ProtocolErrorCode = host
          ? HOST_ERROR_CODES.find((c) => c === hostCode) ?? 'bad_request'
          : 'internal';
        sendError(
          request.id,
          request.method,
          protocolError(code, host ? error.message : 'The request failed.'),
        );
      }
    })();
  };

  const requireCalls = (): AgentCalls => {
    if (!ctx.calls) throw new Error('The agent has no domain calls.');
    return ctx.calls;
  };

  const handle = (envelope: Envelope) => {
    if (envelope.kind !== 'req') {
      ctx.log(`Ignoring an unsolicited ${envelope.kind}.`);
      return;
    }
    const request = parseRequest(envelope);
    if (!request.ok) return sendError(envelope.id, envelope.method, request.error);
    dispatch(request.value);
  };

  socket.on('data', (chunk: Buffer) => {
    if (closing) return;
    for (const result of decoder.push(chunk)) {
      if (!result.ok) return reject(randomUUID(), UNATTRIBUTED_ERROR_METHOD, result.error);
      if (authenticated) handle(result.value);
      else handshake(result.value);
      if (closing) return;
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    clearTimeout(handshakeTimer);
    // A client that goes away cancels what it was waiting for.
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  });
}
