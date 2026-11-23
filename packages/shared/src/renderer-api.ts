import { type DesktopHealth } from './health.js';
import {
  type ClassifyTicket,
  type CreateDepartment,
  type Department,
  type OverrideTicket,
  type TicketView,
} from './ticket.js';

/** Name of the object the preload exposes on `window`. */
export const RENDERER_API_KEY = 'api';

/** IPC channels between the preload and Electron main. */
export const IpcChannels = {
  getHealth: 'agent:get-health',
  listDepartments: 'departments:list',
  createDepartment: 'departments:create',
  classifyTicket: 'tickets:classify',
  listTickets: 'tickets:list',
  overrideTicket: 'tickets:override',
} as const;

/** The fixed `window.api` surface. The renderer gets nothing else. */
export interface RendererApi {
  getHealth(): Promise<DesktopHealth>;
  listDepartments(): Promise<readonly Department[]>;
  createDepartment(input: CreateDepartment): Promise<Department>;
  classifyTicket(input: ClassifyTicket): Promise<TicketView>;
  listTickets(): Promise<readonly TicketView[]>;
  overrideTicket(input: OverrideTicket): Promise<TicketView>;
}
