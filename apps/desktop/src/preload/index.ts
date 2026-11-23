import {
  AgentStatusEventSchema,
  CancelClassifyResultSchema,
  ClassifyTicketSchema,
  ConnectionTestResultSchema,
  CreateDepartmentSchema,
  DeleteDepartmentResultSchema,
  DepartmentSchema,
  DesktopHealthSchema,
  DesktopSettingsViewSchema,
  IpcChannels,
  IpcEvents,
  ModelListSchema,
  OverrideTicketSchema,
  RENDERER_API_KEY,
  StorageInfoSchema,
  TaxonomyStateSchema,
  TicketViewSchema,
  TokenStateSchema,
  type RendererApi,
} from '@ticket/shared';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The renderer's only bridge to main: a fixed, frozen `window.api`.
 * Never ipcRenderer itself, never Node objects. Every response is validated
 * again here against @ticket/shared (strict schemas: an extra field such as a
 * token would fail). Settings input is validated in main, which returns a clean
 * message for the field.
 */
const api: RendererApi = {
  getHealth: async () => DesktopHealthSchema.parse(await ipcRenderer.invoke(IpcChannels.getHealth)),
  onAgentStatus: (listener) => {
    // Never hand the IPC event object to the renderer; validate the payload.
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = AgentStatusEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IpcEvents.agentStatus, handler);
    return () => {
      ipcRenderer.removeListener(IpcEvents.agentStatus, handler);
    };
  },
  listDepartments: async () =>
    DepartmentSchema.array().parse(await ipcRenderer.invoke(IpcChannels.listDepartments)),
  createDepartment: async (input) =>
    DepartmentSchema.parse(
      await ipcRenderer.invoke(IpcChannels.createDepartment, CreateDepartmentSchema.parse(input)),
    ),
  updateDepartment: async (input) =>
    DepartmentSchema.parse(await ipcRenderer.invoke(IpcChannels.updateDepartment, input)),
  getTaxonomy: async () => TaxonomyStateSchema.parse(await ipcRenderer.invoke(IpcChannels.getTaxonomy)),
  deleteDepartment: async (input) =>
    DeleteDepartmentResultSchema.parse(await ipcRenderer.invoke(IpcChannels.deleteDepartment, input)),
  classifyTicket: async (input) =>
    TicketViewSchema.parse(
      await ipcRenderer.invoke(IpcChannels.classifyTicket, ClassifyTicketSchema.parse(input)),
    ),
  cancelClassify: async (input) =>
    CancelClassifyResultSchema.parse(await ipcRenderer.invoke(IpcChannels.cancelClassify, input)),
  listTickets: async () => TicketViewSchema.array().parse(await ipcRenderer.invoke(IpcChannels.listTickets)),
  overrideTicket: async (input) =>
    TicketViewSchema.parse(
      await ipcRenderer.invoke(IpcChannels.overrideTicket, OverrideTicketSchema.parse(input)),
    ),
  getSettings: async () =>
    DesktopSettingsViewSchema.parse(await ipcRenderer.invoke(IpcChannels.getSettings)),
  updateSettings: async (patch) =>
    DesktopSettingsViewSchema.parse(await ipcRenderer.invoke(IpcChannels.updateSettings, patch)),
  testConnection: async (input) =>
    ConnectionTestResultSchema.parse(await ipcRenderer.invoke(IpcChannels.testConnection, input)),
  listModels: async () => ModelListSchema.parse(await ipcRenderer.invoke(IpcChannels.listModels)),
  getStorageInfo: async () => StorageInfoSchema.parse(await ipcRenderer.invoke(IpcChannels.getStorageInfo)),
  saveOllamaToken: async (token) =>
    TokenStateSchema.parse(await ipcRenderer.invoke(IpcChannels.saveOllamaToken, token)),
  clearOllamaToken: async () => TokenStateSchema.parse(await ipcRenderer.invoke(IpcChannels.clearOllamaToken)),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
