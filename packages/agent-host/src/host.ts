import { ClassifyCancelledError, classifyTicketText } from '@ticket/adk-runtime';
import {
  canSendToken,
  createOllamaClient,
  OllamaError,
  type OllamaClient,
} from '@ticket/model-provider';
import {
  acceptQuote,
  aliasKey,
  CreateDepartmentSchema,
  MergeSendersSchema,
  DEPARTMENT_IN_USE_MESSAGE,
  SettingsPatchSchema,
  type ClassifyTicket,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type CreateDepartmentInput,
  type TaxonomyState,
  type MergeSenders,
  type MergeSendersResult,
  type TicketContext,
  type Decision,
  type DeleteDepartment,
  type DeleteDepartmentResult,
  type Department,
  type ModelHealth,
  type ModelList,
  type OverrideTicket,
  type SettingsPatch,
  type SettingsValues,
  type SettingsView,
  type StorageInfo,
  type TicketView,
  type TokenState,
  type UpdateDepartment,
} from '@ticket/shared';
import { type TicketDatabase } from '@ticket/storage';
import { overriddenKeys, resolveSettings, type ResolvedSettings } from './settings.js';

export type HostErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'cancelled';

/** A request the host will not apply. The message names the rule, not the ticket text or a token. */
export class HostError extends Error {
  constructor(
    message: string,
    readonly code: HostErrorCode = 'bad_request',
  ) {
    super(message);
    this.name = 'HostError';
  }
}

const failed = (taxonomyVersion: number): Decision => ({
  departmentId: null,
  confidence: 0,
  rationale: 'The model could not be reached.',
  status: 'failed',
  quote: null,
  taxonomyVersion,
});

/** Refuses an alias that another department already uses (compared case-insensitively). */
function assertAliasesFree(db: TicketDatabase, id: string, aliases: readonly string[] | undefined): void {
  if (!aliases || aliases.length === 0) return;
  const taken = new Map<string, string>();
  for (const department of db.listDepartments()) {
    if (department.id === id) continue;
    for (const alias of department.aliases) taken.set(aliasKey(alias), department.id);
  }
  for (const alias of aliases) {
    const owner = taken.get(aliasKey(alias));
    if (owner) {
      throw new HostError(`The alias "${alias.trim().slice(0, 64)}" already belongs to the department ${owner}.`, 'conflict');
    }
  }
}

export interface AgentHost {
  listDepartments(): readonly Department[];
  createDepartment(input: CreateDepartmentInput): Department;
  /** The current taxonomy version and its history. Read only. */
  taxonomy(): TaxonomyState;
  /** A ticket's sender and that sender's earlier decided tickets (the classifier's data block). */
  ticketContext(input: { readonly id: string }): TicketContext;
  /** Operator merge of two senders. Tickets move; decisions stay as they are. */
  mergeSenders(input: MergeSenders): MergeSendersResult;
  updateDepartment(input: UpdateDepartment): Department;
  deleteDepartment(input: DeleteDepartment): DeleteDepartmentResult;
  /**
   * Classifies and stores the decision. `signal` cancels it: the Ollama request is
   * aborted, no decision is stored, and the externalId can be submitted again. Once the
   * decision is stored, a late cancel changes nothing.
   */
  classify(input: ClassifyTicket, signal?: AbortSignal): Promise<TicketView>;
  listTickets(): readonly TicketView[];
  override(input: OverrideTicket): TicketView;
  modelHealth(): Promise<ModelHealth>;
  getSettings(): SettingsView;
  updateSettings(patch: SettingsPatch): SettingsView;
  /** Kept in memory only. `null` clears it. Never stored, never returned. */
  setToken(token: string | null): TokenState;
  testConnection(input: ConnectionTestRequest): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelList>;
  storageInfo(): StorageInfo;
}

export interface AgentHostOptions {
  readonly db: TicketDatabase;
  /** OLLAMA_HOST, OLLAMA_MODEL, CLASSIFY_MIN_CONFIDENCE override saved settings; OLLAMA_TOKEN is a fallback token. */
  readonly env?: NodeJS.ProcessEnv;
  /** Shown read-only in Settings → Storage. */
  readonly databasePath?: string;
  /** Tests only. */
  readonly fetch?: typeof fetch;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { db } = options;
  const env = options.env ?? process.env;
  const envToken = env['OLLAMA_TOKEN']?.trim() || undefined;
  let shellToken: string | undefined;
  const token = () => shellToken ?? envToken;

  /** Read on every call, so a saved value applies to the next classify without a restart. */
  const resolved = (): ResolvedSettings => resolveSettings(db.readSettings(), env);
  const clientFor = (values: SettingsValues, baseUrl = values.ollamaBaseUrl, timeoutMs = values.connectTimeoutMs): OllamaClient =>
    createOllamaClient(
      {
        baseUrl,
        model: values.model,
        token: token(),
        timeoutMs,
        generateTimeoutMs: values.classifyTimeoutMs,
      },
      options.fetch,
    );
  const view = (): SettingsView => ({ fields: resolved().fields, tokenSet: token() !== undefined });

  let tail: Promise<void> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    listDepartments: () => db.listDepartments(),
    createDepartment(raw) {
      const parsed = CreateDepartmentSchema.safeParse(raw);
      if (!parsed.success) throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid department.');
      const input = parsed.data;
      if (db.listDepartments().some((department) => department.id === input.id)) {
        throw new HostError('A department with that id already exists.', 'conflict');
      }
      assertAliasesFree(db, input.id, input.aliases);
      return db.insertDepartment(input);
    },
    taxonomy: () => db.taxonomy(),
    ticketContext(input) {
      const ticket = db.getById(input.id);
      if (!ticket) throw new HostError('No such ticket.', 'not_found');
      if (ticket.email === null) return { email: null, prior: [] };
      return { email: ticket.email, prior: db.priorTickets(ticket.email, { id: ticket.id, createdAt: ticket.createdAt }) };
    },
    mergeSenders(input) {
      const parsed = MergeSendersSchema.safeParse(input);
      if (!parsed.success) throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid merge.');
      const merged = db.mergeSenders(parsed.data.from, parsed.data.into);
      // Fixed text: the address itself is not echoed into errors or logs.
      if (!merged) throw new HostError('No tickets are linked to the address to merge from.', 'not_found');
      return merged;
    },
    updateDepartment(input) {
      assertAliasesFree(db, input.id, input.aliases);
      const updated = db.updateDepartment(input);
      if (!updated) throw new HostError('No department has that id.', 'not_found');
      return updated;
    },
    deleteDepartment(input) {
      const outcome = db.deleteDepartment(input.id);
      if (outcome === 'missing') throw new HostError('No department has that id.', 'not_found');
      if (outcome === 'referenced') throw new HostError(DEPARTMENT_IN_USE_MESSAGE, 'conflict');
      return { id: input.id, deleted: true };
    },
    listTickets: () => db.listRecent(),
    override(input) {
      const ticket = db.getById(input.id);
      if (!ticket) throw new HostError('No such ticket.', 'not_found');
      const department = db.listDepartments().find((item) => item.id === input.departmentId);
      if (!department?.active) throw new HostError('That department is not active.');
      db.saveDecision(ticket.id, {
        departmentId: department.id,
        confidence: ticket.decision.confidence,
        rationale: ticket.decision.rationale,
        status: 'overridden',
        // The evidence and the version the classifier used stay as they were.
        quote: ticket.decision.quote,
        taxonomyVersion: ticket.decision.taxonomyVersion,
      });
      const updated = db.getById(ticket.id);
      if (!updated) throw new HostError('No such ticket.', 'not_found');
      return updated;
    },
    async modelHealth() {
      const { values } = resolved();
      return { reachable: await clientFor(values).checkReachable(), model: values.model };
    },
    classify: (input, signal) =>
      exclusive(() => {
        const { values } = resolved();
        return classifyOnce(db, clientFor(values), values.minConfidence, input, signal);
      }),

    getSettings: view,
    updateSettings(patch) {
      const parsed = SettingsPatchSchema.safeParse(patch);
      if (!parsed.success) {
        throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid setting.');
      }
      const current = resolved();
      const blocked = overriddenKeys(current).filter((key) => key in parsed.data);
      if (blocked.length > 0) {
        const vars = blocked.map((key) => current.fields[key].envVar).join(', ');
        throw new HostError(`Overridden by ${vars}; remove the variable to change it here.`);
      }
      db.writeSettings(parsed.data);
      return view();
    },
    setToken(next) {
      shellToken = next ?? undefined;
      return { tokenSet: token() !== undefined };
    },
    async testConnection(input) {
      const { values } = resolved();
      const timeoutMs = input.timeoutMs ?? values.connectTimeoutMs;
      // The URL comes from the form and is not saved. Same host rules as classify.
      const baseUrl = input.baseUrl;
      const tokenSent = token() !== undefined && canSendToken(baseUrl);
      try {
        const models = await clientFor(values, baseUrl, timeoutMs).listModels();
        return {
          ok: true,
          message: `Connected. The server reports ${models.length} model${models.length === 1 ? '' : 's'}.`,
          modelCount: models.length,
          tokenSent,
        };
      } catch (error) {
        return { ok: false, message: describeOllamaError(error), modelCount: null, tokenSent };
      }
    },
    async listModels() {
      const { values } = resolved();
      try {
        const models = await clientFor(values).listModels();
        return { reachable: true, server: values.ollamaBaseUrl, models: [...models], message: '' };
      } catch (error) {
        return { reachable: false, server: values.ollamaBaseUrl, models: [], message: describeOllamaError(error) };
      }
    },
    storageInfo() {
      const counts = db.counts();
      return {
        databasePath: options.databasePath ?? '',
        departmentCount: counts.departments,
        ticketCount: counts.tickets,
      };
    },
  };
}

/** Fixed text per failure. Never the URL or the token. */
function describeOllamaError(error: unknown): string {
  if (!(error instanceof OllamaError)) return 'The server could not be checked.';
  switch (error.code) {
    case 'redirect':
      return 'The server answered with a redirect. Redirects are not followed.';
    case 'timeout':
      return 'The server did not answer in time.';
    case 'network':
      return 'The server is not reachable.';
    case 'http':
      return error.message;
    default:
      return 'The server did not answer like Ollama.';
  }
}

const cancelled = () => new HostError('The classify was cancelled. Nothing was stored.', 'cancelled');

async function classifyOnce(
  db: TicketDatabase,
  ollama: OllamaClient,
  minConfidence: number,
  input: ClassifyTicket,
  signal?: AbortSignal,
): Promise<TicketView> {
  // A stored decision is returned as is: no second model call. A repeat that brings
  // an email for a ticket stored without one only attaches the email.
  const stored = db.findByExternalId(input.externalId);
  if (stored) {
    if (input.email && stored.email === null && db.attachEmail(stored.id, input.email)) {
      return db.getById(stored.id) ?? stored;
    }
    return stored;
  }
  // Cancelled while waiting in the queue.
  if (signal?.aborted) throw cancelled();

  // Sender memory: only the email field identifies a person; no email, no memory.
  // Read before the new row exists, so the new ticket is never its own history.
  const history = input.email ? db.priorTickets(input.email) : [];

  // Reuses a row left without a decision by a crash or a cancel.
  const created = db.insertTicket(input);
  // The classifier sees only active departments. The version is read with the
  // catalogue (no await in between), so the decision records the version it used.
  const active = db.listDepartments().filter((department) => department.active);
  const taxonomyVersion = db.taxonomyVersion();
  let decision: Decision;
  try {
    const output = await classifyTicketText({
      ollama,
      departments: active,
      ticket: input,
      history,
      ...(signal && { signal }),
    });
    // Only an exact active id counts; an alias or a name is not an id.
    const known = active.some((department) => department.id === output.departmentId);
    // Kept only if it is an exact substring of this ticket; never re-asked.
    const quote = acceptQuote(output.quote, input);
    if (!known || output.confidence < minConfidence) {
      decision = {
        departmentId: null,
        confidence: output.confidence,
        rationale: output.rationale,
        status: 'needs_review',
        quote,
        taxonomyVersion,
      };
    } else {
      decision = {
        departmentId: output.departmentId,
        confidence: output.confidence,
        rationale: output.rationale,
        status: 'labeled',
        quote,
        taxonomyVersion,
      };
    }
  } catch (error) {
    if (signal?.aborted || error instanceof ClassifyCancelledError) {
      db.discardUndecided(created.id);
      throw cancelled();
    }
    decision = failed(taxonomyVersion);
  }
  // Cancelled after the model answered but before the save: store nothing.
  if (signal?.aborted) {
    db.discardUndecided(created.id);
    throw cancelled();
  }
  db.saveDecision(created.id, decision);
  const view = db.getById(created.id);
  if (!view) throw new HostError('No such ticket.', 'not_found');
  return view;
}
