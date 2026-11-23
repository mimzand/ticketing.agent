import { type AgentLink } from '@ticket/agent-client';
import {
  CancelClassifySchema,
  CLASSIFY_TIMEOUT_DEFAULT_MS,
  ClassifyTicketSchema,
  classifyRequestTimeoutMs,
  ConnectionTestRequestSchema,
  ConnectionTestResultSchema,
  CreateDepartmentSchema,
  DeleteDepartmentResultSchema,
  DeleteDepartmentSchema,
  DepartmentSchema,
  DesktopSettingsViewSchema,
  IpcChannels,
  ModelListSchema,
  OverrideTicketSchema,
  SettingsPatchSchema,
  SettingsViewSchema,
  StorageInfoSchema,
  TicketViewSchema,
  TokenStateSchema,
  UpdateDepartmentSchema,
  type DesktopSettingsView,
  type TokenState,
} from '@ticket/shared';
import { type ZodType } from 'zod';
import { type SupervisorStatus } from './agent-supervisor.js';
import { readAgentHealth } from './health.js';
import { type TokenStore } from './token-store.js';

type Channel = (typeof IpcChannels)[keyof typeof IpcChannels];
export type IpcHandler = (raw: unknown) => Promise<unknown>;

export interface IpcDeps {
  readonly agent: Pick<AgentLink, 'request' | 'ping'>;
  readonly tokens: TokenStore;
  /** The utility-process supervisor; absent in tests that only need the handlers. */
  readonly supervisor?: { status(): SupervisorStatus };
}

/** A clean message for the renderer: the first schema issue, never the input value. */
export class IpcInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcInputError';
  }
}

function input<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IpcInputError(parsed.error.issues[0]?.message ?? 'Invalid input.');
  return parsed.data;
}

/**
 * Every handler behind `window.api`. Inputs are validated with @ticket/shared
 * before they reach the agent, and every result is validated again before it goes
 * back. No result carries the Ollama access token.
 */
export function createIpcHandlers(deps: IpcDeps): Record<Channel, IpcHandler> {
  const { agent, tokens } = deps;
  /** In-flight submits by externalId, so the ticket screen can cancel one. */
  const submits = new Map<string, AbortController>();

  const settingsView = async (view?: unknown): Promise<DesktopSettingsView> =>
    DesktopSettingsViewSchema.parse({
      ...SettingsViewSchema.parse(view ?? (await agent.request('settings.get', {}))),
      tokenEncryptionAvailable: tokens.encryptionAvailable(),
    });

  return {
    [IpcChannels.getHealth]: () => readAgentHealth(agent, undefined, deps.supervisor),
    [IpcChannels.listDepartments]: async () =>
      DepartmentSchema.array().parse(await agent.request('departments.list', {})),
    [IpcChannels.createDepartment]: async (raw) =>
      DepartmentSchema.parse(await agent.request('departments.create', input(CreateDepartmentSchema, raw))),
    [IpcChannels.updateDepartment]: async (raw) =>
      DepartmentSchema.parse(await agent.request('departments.update', input(UpdateDepartmentSchema, raw))),
    [IpcChannels.deleteDepartment]: async (raw) =>
      DeleteDepartmentResultSchema.parse(
        await agent.request('departments.delete', input(DeleteDepartmentSchema, raw)),
      ),
    [IpcChannels.classifyTicket]: async (raw) => {
      const ticket = input(ClassifyTicketSchema, raw);
      if (submits.has(ticket.externalId)) throw new IpcInputError('This ticket is already being classified.');
      const controller = new AbortController();
      submits.set(ticket.externalId, controller);
      try {
        // Wait past the model's own budget. A client timeout also sends system.cancel,
        // so a slow call cannot store a decision after the window has moved on.
        let timeoutMs = classifyRequestTimeoutMs(CLASSIFY_TIMEOUT_DEFAULT_MS);
        try {
          const view = SettingsViewSchema.parse(await agent.request('settings.get', {}));
          timeoutMs = classifyRequestTimeoutMs(view.fields.classifyTimeoutMs.value);
        } catch {
          // The classify call below reports a missing agent.
        }
        const result = await agent.request('tickets.classify', ticket, { signal: controller.signal, timeoutMs });
        return TicketViewSchema.parse(result);
      } finally {
        if (submits.get(ticket.externalId) === controller) submits.delete(ticket.externalId);
      }
    },
    [IpcChannels.cancelClassify]: async (raw) => {
      const { externalId } = input(CancelClassifySchema, raw);
      const controller = submits.get(externalId);
      controller?.abort();
      return { cancelled: controller !== undefined };
    },
    [IpcChannels.listTickets]: async () =>
      TicketViewSchema.array().parse(await agent.request('tickets.list', {})),
    [IpcChannels.overrideTicket]: async (raw) =>
      TicketViewSchema.parse(await agent.request('tickets.override', input(OverrideTicketSchema, raw))),

    [IpcChannels.getSettings]: () => settingsView(),
    [IpcChannels.updateSettings]: async (raw) =>
      // Validated here before save; an invalid value never reaches the agent.
      settingsView(await agent.request('settings.update', input(SettingsPatchSchema, raw))),
    [IpcChannels.testConnection]: async (raw) =>
      ConnectionTestResultSchema.parse(
        await agent.request('settings.testConnection', input(ConnectionTestRequestSchema, raw)),
      ),
    [IpcChannels.listModels]: async () => ModelListSchema.parse(await agent.request('models.list', {})),
    [IpcChannels.getStorageInfo]: async () =>
      StorageInfoSchema.parse(await agent.request('storage.info', {})),

    [IpcChannels.saveOllamaToken]: async (raw): Promise<TokenState> => {
      if (typeof raw !== 'string') throw new IpcInputError('Enter the token.');
      // Refuses (and writes nothing) when safeStorage cannot encrypt.
      const token = tokens.save(raw);
      try {
        return TokenStateSchema.parse(await agent.request('settings.setToken', { token }));
      } catch {
        // Saved encrypted; main hands it over when the agent connects next.
        return { tokenSet: true };
      }
    },
    [IpcChannels.clearOllamaToken]: async (): Promise<TokenState> => {
      tokens.clear();
      try {
        return TokenStateSchema.parse(await agent.request('settings.setToken', { token: null }));
      } catch {
        return { tokenSet: false };
      }
    },
  };
}
