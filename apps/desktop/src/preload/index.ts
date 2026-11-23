import {
  ClassifyTicketSchema,
  ConnectionTestResultSchema,
  CreateDepartmentSchema,
  DeleteDepartmentResultSchema,
  DepartmentSchema,
  DesktopHealthSchema,
  DesktopSettingsViewSchema,
  IpcChannels,
  ModelListSchema,
  OverrideTicketSchema,
  RENDERER_API_KEY,
  StorageInfoSchema,
  TicketViewSchema,
  TokenStateSchema,
  type RendererApi,
} from '@ticket/shared';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only bridge to main: a fixed, frozen `window.api`.
 * Never ipcRenderer itself, never Node objects. Every response is validated
 * again here against @ticket/shared (strict schemas: an extra field such as a
 * token would fail). Settings input is validated in main, which returns a clean
 * message for the field.
 */
const api: RendererApi = {
  getHealth: async () => DesktopHealthSchema.parse(await ipcRenderer.invoke(IpcChannels.getHealth)),
  listDepartments: async () =>
    DepartmentSchema.array().parse(await ipcRenderer.invoke(IpcChannels.listDepartments)),
  createDepartment: async (input) =>
    DepartmentSchema.parse(
      await ipcRenderer.invoke(IpcChannels.createDepartment, CreateDepartmentSchema.parse(input)),
    ),
  updateDepartment: async (input) =>
    DepartmentSchema.parse(await ipcRenderer.invoke(IpcChannels.updateDepartment, input)),
  deleteDepartment: async (input) =>
    DeleteDepartmentResultSchema.parse(await ipcRenderer.invoke(IpcChannels.deleteDepartment, input)),
  classifyTicket: async (input) =>
    TicketViewSchema.parse(
      await ipcRenderer.invoke(IpcChannels.classifyTicket, ClassifyTicketSchema.parse(input)),
    ),
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
