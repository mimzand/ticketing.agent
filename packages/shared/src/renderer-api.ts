import { type AgentStatusEvent, type DesktopHealth } from './health.js';
import {
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type DesktopSettingsView,
  type ModelList,
  type SettingsPatch,
  type StorageInfo,
  type TokenState,
} from './settings.js';
import {
  type CancelClassify,
  type CancelClassifyResult,
  type ClassifyTicket,
  type CreateDepartmentInput,
  type TaxonomyState,
  type MergeSendersInput,
  type MergeSendersResult,
  type TicketContext,
  type DeleteDepartment,
  type DeleteDepartmentResult,
  type Department,
  type OverrideTicket,
  type TicketView,
  type UpdateDepartment,
} from './ticket.js';
import {
  type Category,
  type CreateCategoryInput,
  type DeleteCategory,
  type DeleteCategoryResult,
  type SetTicketCategory,
  type SetTicketPriority,
  type UpdateCategory,
} from './category.js';
import { type ReviewQueue } from './review.js';

/** Name of the object the preload exposes on `window`. */
export const RENDERER_API_KEY = 'api';

/** IPC channels between the preload and Electron main. */
export const IpcChannels = {
  getHealth: 'agent:get-health',
  listDepartments: 'departments:list',
  createDepartment: 'departments:create',
  updateDepartment: 'departments:update',
  deleteDepartment: 'departments:delete',
  getTaxonomy: 'departments:taxonomy',
  listCategories: 'categories:list',
  createCategory: 'categories:create',
  updateCategory: 'categories:update',
  deleteCategory: 'categories:delete',
  classifyTicket: 'tickets:classify',
  cancelClassify: 'tickets:cancel-classify',
  listTickets: 'tickets:list',
  reviewQueue: 'tickets:review-queue',
  overrideTicket: 'tickets:override',
  setTicketCategory: 'tickets:set-category',
  setTicketPriority: 'tickets:set-priority',
  ticketContext: 'tickets:context',
  mergeSender: 'senders:merge',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  testConnection: 'settings:test-connection',
  listModels: 'settings:list-models',
  getStorageInfo: 'settings:storage-info',
  saveOllamaToken: 'settings:save-token',
  clearOllamaToken: 'settings:clear-token',
} as const;

/** Events from Electron main to the renderer. */
export const IpcEvents = {
  agentStatus: 'agent:status',
} as const;

/**
 * The fixed `window.api` surface. The renderer gets nothing else. Nothing here
 * returns the Ollama access token: `saveOllamaToken` takes it and answers only
 * whether a token is set.
 */
export interface RendererApi {
  getHealth(): Promise<DesktopHealth>;
  /** Supervisor state changes (started, attached, reconnecting…). Returns an unsubscribe function. */
  onAgentStatus(listener: (status: AgentStatusEvent) => void): () => void;
  listDepartments(): Promise<readonly Department[]>;
  createDepartment(input: CreateDepartmentInput): Promise<Department>;
  updateDepartment(input: UpdateDepartment): Promise<Department>;
  deleteDepartment(input: DeleteDepartment): Promise<DeleteDepartmentResult>;
  /** The current taxonomy version and its read-only history. */
  getTaxonomy(): Promise<TaxonomyState>;
  /** Problem categories, inactive ones included. */
  listCategories(): Promise<readonly Category[]>;
  createCategory(input: CreateCategoryInput): Promise<Category>;
  updateCategory(input: UpdateCategory): Promise<Category>;
  deleteCategory(input: DeleteCategory): Promise<DeleteCategoryResult>;
  classifyTicket(input: ClassifyTicket): Promise<TicketView>;
  /**
   * Cancels the in-flight submit of this externalId. The pending `classifyTicket` then
   * rejects; nothing is stored, and the same externalId can be submitted again.
   */
  cancelClassify(input: CancelClassify): Promise<CancelClassifyResult>;
  listTickets(): Promise<readonly TicketView[]>;
  /** needs_review and failed tickets, oldest first, at most 200, with full counts. */
  reviewQueue(): Promise<ReviewQueue>;
  overrideTicket(input: OverrideTicket): Promise<TicketView>;
  /** Admin category (active only). Department fields and priority do not change. */
  setTicketCategory(input: SetTicketCategory): Promise<TicketView>;
  /** Admin priority review. Department fields and category do not change. */
  setTicketPriority(input: SetTicketPriority): Promise<TicketView>;
  /** The ticket's sender (or null) and that sender's earlier decided tickets. */
  ticketContext(id: string): Promise<TicketContext>;
  /** Operator merge: moves every ticket of `from` onto `into`. Decisions are not changed. */
  mergeSender(input: MergeSendersInput): Promise<MergeSendersResult>;
  getSettings(): Promise<DesktopSettingsView>;
  updateSettings(patch: SettingsPatch): Promise<DesktopSettingsView>;
  testConnection(input: ConnectionTestRequest): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelList>;
  getStorageInfo(): Promise<StorageInfo>;
  saveOllamaToken(token: string): Promise<TokenState>;
  clearOllamaToken(): Promise<TokenState>;
}
