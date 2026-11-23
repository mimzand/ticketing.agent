import { createAgentLink } from '@ticket/agent-client';
import {
  ClassifyTicketSchema,
  CreateDepartmentSchema,
  DepartmentSchema,
  IpcChannels,
  OverrideTicketSchema,
  TicketViewSchema,
} from '@ticket/shared';
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { resolveAgentStateFile } from './config.js';
import { readAgentHealth } from './health.js';
import { isAppUrl, type AppUrlOptions } from './security.js';
import { createMainWindow, rendererIndexPath } from './window.js';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const urls: AppUrlOptions = { devServerUrl, rendererIndexPath: rendererIndexPath() };

const agent = createAgentLink({
  stateFile: resolveAgentStateFile(process.env, app.getAppPath()),
  client: { kind: 'shell', version: app.getVersion() },
  log: (message) => console.info(`[desktop] ${message}`),
});

/** Only our own top-level page may call main. */
const fromApp = (event: IpcMainInvokeEvent): boolean =>
  event.senderFrame !== null &&
  event.senderFrame === event.sender.mainFrame &&
  isAppUrl(event.senderFrame.url, urls);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    const guard = (event: IpcMainInvokeEvent) => {
      if (!fromApp(event)) throw new Error('Refused: not the app window.');
    };
    ipcMain.handle(IpcChannels.getHealth, async (event) => {
      guard(event);
      return readAgentHealth(agent);
    });
    ipcMain.handle(IpcChannels.listDepartments, async (event) => {
      guard(event);
      return DepartmentSchema.array().parse(await agent.request('departments.list', {}));
    });
    ipcMain.handle(IpcChannels.createDepartment, async (event, raw: unknown) => {
      guard(event);
      const input = CreateDepartmentSchema.parse(raw);
      return DepartmentSchema.parse(await agent.request('departments.create', input));
    });
    ipcMain.handle(IpcChannels.classifyTicket, async (event, raw: unknown) => {
      guard(event);
      const input = ClassifyTicketSchema.parse(raw);
      return TicketViewSchema.parse(await agent.request('tickets.classify', input));
    });
    ipcMain.handle(IpcChannels.listTickets, async (event) => {
      guard(event);
      return TicketViewSchema.array().parse(await agent.request('tickets.list', {}));
    });
    ipcMain.handle(IpcChannels.overrideTicket, async (event, raw: unknown) => {
      guard(event);
      const input = OverrideTicketSchema.parse(raw);
      return TicketViewSchema.parse(await agent.request('tickets.override', input));
    });
    createMainWindow({ ...urls, allowDevTools: !app.isPackaged });
  });

  app.on('window-all-closed', () => {
    agent.close();
    app.quit();
  });
}
