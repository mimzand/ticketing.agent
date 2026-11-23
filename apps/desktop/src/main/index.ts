import { AgentClientError, connectFromStateFile, createAgentLink } from '@ticket/agent-client';
import { IpcEvents } from '@ticket/shared';
import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { agentEntryPath, createAgentSupervisor } from './agent-supervisor.js';
import { resolveAgentStateFile, resolveTicketDatabase } from './config.js';
import { createDesktopLog } from './desktop-log.js';
import { createIpcHandlers, IpcInputError } from './ipc.js';
import { isAppUrl, type AppUrlOptions } from './security.js';
import { createTokenStore, TokenStoreError } from './token-store.js';
import { createMainWindow, rendererIndexPath } from './window.js';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const urls: AppUrlOptions = { devServerUrl, rendererIndexPath: rendererIndexPath() };
const userData = app.getPath('userData');
const packaged = app.isPackaged ? { userData } : undefined;
const log = createDesktopLog({ file: join(userData, 'logs', 'desktop.log') });

/** safeStorage-encrypted Ollama access token. Read only to hand it to the agent. */
const tokens = createTokenStore({ safeStorage, filePath: join(userData, 'ollama-token.bin') });

const stateFile = resolveAgentStateFile(process.env, app.getAppPath(), packaged);

/**
 * Attaches to a live agent (yarn agent:dev / api:up) or starts the app's own with
 * utilityProcess.fork. This is the only place the app starts a process.
 */
const supervisor = createAgentSupervisor({
  fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
  entry: agentEntryPath(app.getAppPath()),
  stateFile,
  databaseFile: resolveTicketDatabase(process.env, app.getAppPath(), packaged),
  env: process.env,
  parentPid: process.pid,
  appVersion: app.getVersion(),
  log,
  // The sidebar shows "Reconnecting…" as soon as a crash is noticed.
  onStatus: (status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcEvents.agentStatus, status);
    }
  },
});

const agent = createAgentLink({
  stateFile,
  client: { kind: 'shell', version: app.getVersion() },
  log: (message) => log.info(message),
  // Every new connection first makes sure an agent is there (attach, start, or wait
  // for the restart after a crash).
  connect: async (path, options) => {
    await supervisor.ensure();
    return connectFromStateFile(path, options);
  },
  // The agent keeps the token in memory only, so a restarted agent gets it again here.
  onConnect: async (client) => {
    const token = tokens.load();
    if (token) await client.request('settings.setToken', { token });
  },
});

/** Only our own top-level page may call main. */
const fromApp = (event: IpcMainInvokeEvent): boolean =>
  event.senderFrame !== null &&
  event.senderFrame === event.sender.mainFrame &&
  isAppUrl(event.senderFrame.url, urls);

function rendererError(channel: string, error: unknown): Error {
  // Messages the operator can act on travel; anything else stays generic.
  if (error instanceof IpcInputError || error instanceof TokenStoreError) return error;
  if (error instanceof AgentClientError) {
    if (error.code === 'cancelled') return new Error('Cancelled. Nothing was stored.', { cause: error });
    if (error.code === 'unknown_method') {
      return new Error(
        'The running agent is an older version and does not know this request. Restart it.',
        { cause: error },
      );
    }
    return new Error(error.message, { cause: error });
  }
  log.warn(`${channel} failed.`);
  // Electron sends only the message to the renderer; the cause stays in main.
  return new Error('The request failed.', { cause: error });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    const handlers = createIpcHandlers({ agent, tokens, supervisor });
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, async (event, raw: unknown) => {
        if (!fromApp(event)) throw new Error('Refused: not the app window.');
        try {
          return await handler(raw);
        } catch (error) {
          throw rendererError(channel, error);
        }
      });
    }
    createMainWindow({ ...urls, allowDevTools: !app.isPackaged });
    // Start (or attach to) the agent now rather than on the first request.
    void supervisor.ensure().catch(() => log.warn('The agent could not be started yet.'));
  });

  app.on('window-all-closed', () => app.quit());

  // Quit: close our connection, then `system.shutdown` to our own agent and wait, so
  // the state file is gone when the app is. An attached agent keeps running.
  let quitting = false;
  app.on('will-quit', (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    agent.close();
    // app.exit, not app.quit: quit is already under way and must not run will-quit again.
    void supervisor.stop().finally(() => app.exit(0));
  });
}
