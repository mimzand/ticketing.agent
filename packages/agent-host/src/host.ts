import { ClassifyCancelledError, classifyTicketText, type ModelReply } from '@ticket/adk-runtime';
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
  senderSummary,
  OVERRIDE_FEEDBACK_LIMIT,
  OverrideFeedbackSchema,
  type OverrideFeedback,
  CATEGORY_IN_USE_MESSAGE,
  CreateCategorySchema,
  priorityTrends,
  SetTicketCategorySchema,
  SetTicketPrioritySchema,
  TicketPrioritySchema,
  UpdateCategorySchema,
  type Category,
  type CreateCategoryInput,
  type DeleteCategory,
  type DeleteCategoryResult,
  type SetTicketCategory,
  type SetTicketPriority,
  type TicketPriority,
  type UpdateCategory,
  type ClassifierOutput,
  DECISION_FEEDBACK_LIMIT,
  DecisionFeedbackSchema,
  REVIEW_QUEUE_LIMIT,
  type DecisionFeedback,
  type ReviewQueue,
} from '@ticket/shared';
import { type SaveDecisionInput, type TicketDatabase } from '@ticket/storage';
import {
  DecisionEventSchema,
  failureCodeOf,
  isRetryable,
  type DecisionEvent,
} from './decision-event.js';
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

const failed = (taxonomyVersion: number): SaveDecisionInput => ({
  departmentId: null,
  confidence: 0,
  rationale: 'The model could not be reached.',
  status: 'failed',
  quote: null,
  taxonomyVersion,
  categoryId: null,
  priority: null,
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
  /**
   * Read-only export of overrides that replaced a classifier department, with the
   * current catalogue. No email. Nothing is written to departments or examples.
   */
  overrideFeedback(): OverrideFeedback;
  /**
   * The human review queue: `needs_review` and `failed` tickets, oldest first, at
   * most 200, with full counts. A department override resolves a ticket.
   */
  reviewQueue(): ReviewQueue;
  /**
   * Read-only export of admin-reviewed category and priority decisions, with the
   * current catalogues. No email. Nothing is written anywhere.
   */
  decisionFeedback(): DecisionFeedback;
  /** Every category, inactive ones included. */
  listCategories(): readonly Category[];
  createCategory(input: CreateCategoryInput): Category;
  updateCategory(input: UpdateCategory): Category;
  /** Refused (conflict) while a decision stores the id; deactivate instead. */
  deleteCategory(input: DeleteCategory): DeleteCategoryResult;
  /**
   * Admin category. Only an active category. The first time keeps the model category
   * as the replaced one. Department fields and priority are not changed.
   */
  setCategory(input: SetTicketCategory): TicketView;
  /**
   * Admin priority review. The first time keeps the model priority as the replaced one.
   * Department fields and category are not changed.
   */
  setPriority(input: SetTicketPriority): TicketView;
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
  /**
   * One secret-free event per stored classify outcome (not for a cancel). A throwing
   * callback never fails the classify.
   */
  readonly onDecisionEvent?: (event: DecisionEvent) => void;
  /**
   * Development and test hook (eval recording): the complete raw assistant message of
   * each model answer. Not exposed through the protocol, the API, or the desktop.
   */
  readonly onModelReply?: (reply: ModelReply) => void;
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
      if (ticket.email === null) return { email: null, prior: [], summary: senderSummary([]) };
      const prior = db.priorTickets(ticket.email, { id: ticket.id, createdAt: ticket.createdAt });
      return { email: ticket.email, prior, summary: senderSummary(prior) };
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
      // Only the department and status change; the first override keeps what the
      // classifier had applied as the replaced department. Confidence, rationale,
      // quote, and taxonomy version stay as they were.
      if (!db.overrideDecision(ticket.id, department.id)) throw new HostError('No such ticket.', 'not_found');
      const updated = db.getById(ticket.id);
      if (!updated) throw new HostError('No such ticket.', 'not_found');
      return updated;
    },
    overrideFeedback() {
      return OverrideFeedbackSchema.parse({
        taxonomyVersion: db.taxonomyVersion(),
        departments: db.listDepartments(),
        items: db.overrideFeedback(OVERRIDE_FEEDBACK_LIMIT),
      });
    },
    reviewQueue: () => db.reviewQueue(REVIEW_QUEUE_LIMIT),
    decisionFeedback() {
      return DecisionFeedbackSchema.parse({
        taxonomyVersion: db.taxonomyVersion(),
        departments: db.listDepartments(),
        categories: db.listCategories(),
        items: db.decisionFeedback(DECISION_FEEDBACK_LIMIT),
      });
    },
    listCategories: () => db.listCategories(),
    createCategory(raw) {
      const parsed = CreateCategorySchema.safeParse(raw);
      if (!parsed.success) throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid category.');
      if (db.listCategories().some((category) => category.id === parsed.data.id)) {
        throw new HostError('A category with that id already exists.', 'conflict');
      }
      return db.insertCategory(parsed.data);
    },
    updateCategory(raw) {
      const parsed = UpdateCategorySchema.safeParse(raw);
      if (!parsed.success) throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid category.');
      const updated = db.updateCategory(parsed.data);
      if (!updated) throw new HostError('No category has that id.', 'not_found');
      return updated;
    },
    deleteCategory(input) {
      const outcome = db.deleteCategory(input.id);
      if (outcome === 'missing') throw new HostError('No category has that id.', 'not_found');
      if (outcome === 'referenced') throw new HostError(CATEGORY_IN_USE_MESSAGE, 'conflict');
      return { id: input.id, deleted: true };
    },
    setCategory(raw) {
      const parsed = SetTicketCategorySchema.safeParse(raw);
      if (!parsed.success) throw new HostError(parsed.error.issues[0]?.message ?? 'Invalid category.');
      const ticket = db.getById(parsed.data.id);
      if (!ticket) throw new HostError('No such ticket.', 'not_found');
      const category = db.listCategories().find((item) => item.id === parsed.data.categoryId);
      if (!category?.active) throw new HostError('That category is not active.');
      if (!db.setCategory(ticket.id, category.id)) throw new HostError('No such ticket.', 'not_found');
      const updated = db.getById(ticket.id);
      if (!updated) throw new HostError('No such ticket.', 'not_found');
      return updated;
    },
    setPriority(raw) {
      const parsed = SetTicketPrioritySchema.safeParse(raw);
      if (!parsed.success) throw new HostError('Priority is one of low, normal, high, urgent.');
      const ticket = db.getById(parsed.data.id);
      if (!ticket) throw new HostError('No such ticket.', 'not_found');
      if (!db.setPriority(ticket.id, parsed.data.priority)) throw new HostError('No such ticket.', 'not_found');
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
        // A fallback equal to the primary model is never a second attempt.
        const fallbackModel =
          values.fallbackModel !== null && values.fallbackModel !== values.model ? values.fallbackModel : null;
        return classifyOnce(
          {
            db,
            minConfidence: values.minConfidence,
            classifyTimeoutMs: values.classifyTimeoutMs,
            primary: clientFor(values),
            fallbackFor: fallbackModel
              ? (timeoutMs) => clientFor({ ...values, model: fallbackModel, classifyTimeoutMs: timeoutMs })
              : null,
            onDecisionEvent: options.onDecisionEvent,
            onModelReply: options.onModelReply,
          },
          input,
          signal,
        );
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
      // The fallback must differ from the primary model that would be in effect.
      const next = resolveSettings({ ...db.readSettings(), ...parsed.data }, env).values;
      if (next.fallbackModel !== null && next.fallbackModel === next.model) {
        throw new HostError('The fallback model must differ from the primary model.');
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

/** Below this many milliseconds of the classify budget, the fallback model is not started. */
export const FALLBACK_MIN_BUDGET_MS = 1_000;

interface ClassifyRun {
  readonly db: TicketDatabase;
  readonly minConfidence: number;
  /** The caller-visible budget for every attempt together. */
  readonly classifyTimeoutMs: number;
  readonly primary: OllamaClient;
  /** A client for the fallback model with the remaining budget, or null when none is configured. */
  readonly fallbackFor: ((timeoutMs: number) => OllamaClient) | null;
  readonly onDecisionEvent?: ((event: DecisionEvent) => void) | undefined;
  readonly onModelReply?: ((reply: ModelReply) => void) | undefined;
}

async function classifyOnce(run: ClassifyRun, input: ClassifyTicket, signal?: AbortSignal): Promise<TicketView> {
  const { db, minConfidence } = run;
  const startedAt = Date.now();
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
  // Categories: only active ones are offered. The admin priority record is counts
  // over every admin-reviewed decision, grouped by final category; never ticket text.
  const categories = db.listCategories().filter((category) => category.active);
  const listed = new Set(categories.map((category) => category.id));
  const trends = priorityTrends(db.priorityAggregates()).filter((trend) => listed.has(trend.categoryId));

  const ask = (ollama: OllamaClient) =>
    classifyTicketText({
      ollama,
      departments: active,
      ticket: input,
      history,
      categories: { categories, priorityTrends: trends },
      ...(signal && { signal }),
      ...(run.onModelReply && { onModelReply: run.onModelReply }),
    });
  const stopIfCancelled = (error?: unknown) => {
    if (signal?.aborted || error instanceof ClassifyCancelledError) {
      db.discardUndecided(created.id);
      throw cancelled();
    }
  };

  // At most two attempts: the primary model, then the fallback model once, only after
  // a retryable failure and only within the same total budget. A response is never
  // merged with another one; the one that parses goes through the host rules below.
  let output: ClassifierOutput | null = null;
  let attempts: 1 | 2 = 1;
  let modelRole: 'primary' | 'fallback' = 'primary';
  let failure: unknown = null;
  try {
    output = await ask(run.primary);
  } catch (error) {
    stopIfCancelled(error);
    failure = error;
  }
  const remaining = run.classifyTimeoutMs - (Date.now() - startedAt);
  if (output === null && run.fallbackFor && isRetryable(failure) && remaining >= FALLBACK_MIN_BUDGET_MS) {
    attempts = 2;
    modelRole = 'fallback';
    try {
      output = await ask(run.fallbackFor(remaining));
      failure = null;
    } catch (error) {
      stopIfCancelled(error);
      failure = error;
    }
  }

  let decision: SaveDecisionInput;
  if (output === null) {
    decision = failed(taxonomyVersion);
  } else {
    // Independent of the department rules: an exact active category id or null, one of
    // the four priorities or null. Nothing is coerced, and a category default never
    // replaces the model's priority.
    const categoryId = typeof output.categoryId === 'string' && listed.has(output.categoryId) ? output.categoryId : null;
    const priority: TicketPriority | null = TicketPrioritySchema.safeParse(output.priority).data ?? null;
    // Only an exact active id counts; an alias or a name is not an id.
    const departmentId = output.departmentId;
    const known = active.some((department) => department.id === departmentId);
    // Kept only if it is an exact substring of this ticket; never re-asked.
    const quote = acceptQuote(output.quote, input);
    const labeled = known && output.confidence >= minConfidence;
    decision = {
      departmentId: labeled ? departmentId : null,
      confidence: output.confidence,
      rationale: output.rationale,
      status: labeled ? 'labeled' : 'needs_review',
      quote,
      taxonomyVersion,
      categoryId,
      priority,
    };
  }
  // Cancelled after the model answered but before the save: store nothing.
  stopIfCancelled();
  db.saveDecision(created.id, decision);
  const view = db.getById(created.id);
  if (!view) throw new HostError('No such ticket.', 'not_found');
  emitDecisionEvent(run.onDecisionEvent, {
    event: 'ticket_classified',
    ticketId: view.id,
    status: decision.status === 'labeled' || decision.status === 'needs_review' ? decision.status : 'failed',
    departmentId: view.decision.departmentId,
    categoryId: view.decision.categoryId,
    priority: view.decision.priority,
    confidence: view.decision.confidence,
    taxonomyVersion: view.decision.taxonomyVersion,
    historyCount: history.length,
    quoteAccepted: view.decision.quote !== null,
    durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
    attempts,
    modelRole,
    failureCode: output === null ? failureCodeOf(failure) : null,
  });
  return view;
}

/** Logging never fails a classify: an invalid event or a throwing callback is dropped. */
function emitDecisionEvent(callback: ((event: DecisionEvent) => void) | undefined, event: DecisionEvent): void {
  if (!callback) return;
  try {
    callback(DecisionEventSchema.parse(event));
  } catch {
    // Swallowed on purpose: the decision is already stored.
  }
}
