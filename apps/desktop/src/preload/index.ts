import {
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DepartmentSchema,
  DesktopHealthSchema,
  IpcChannels,
  OverrideTicketSchema,
  RENDERER_API_KEY,
  TicketViewSchema,
  type RendererApi,
} from '@ticket/shared';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only bridge to main: a fixed, frozen `window.api`.
 * Never ipcRenderer itself, never Node objects. Responses are validated
 * again here against @ticket/shared.
 */
const api: RendererApi = {
  getHealth: async () => DesktopHealthSchema.parse(await ipcRenderer.invoke(IpcChannels.getHealth)),
  listDepartments: async () =>
    DepartmentSchema.array().parse(await ipcRenderer.invoke(IpcChannels.listDepartments)),
  createDepartment: async (input) =>
    DepartmentSchema.parse(
      await ipcRenderer.invoke(IpcChannels.createDepartment, CreateDepartmentSchema.parse(input)),
    ),
  classifyTicket: async (input) =>
    TicketViewSchema.parse(
      await ipcRenderer.invoke(IpcChannels.classifyTicket, ClassifyTicketSchema.parse(input)),
    ),
  listTickets: async () => TicketViewSchema.array().parse(await ipcRenderer.invoke(IpcChannels.listTickets)),
  overrideTicket: async (input) =>
    TicketViewSchema.parse(
      await ipcRenderer.invoke(IpcChannels.overrideTicket, OverrideTicketSchema.parse(input)),
    ),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
