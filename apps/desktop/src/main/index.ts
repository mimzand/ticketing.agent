import { AgentClientError, createAgentLink } from '@ticket/agent-client';
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { resolveAgentStateFile } from './config.js';
import { createIpcHandlers, IpcInputError } from './ipc.js';
import { isAppUrl, type AppUrlOptions } from './security.js';
import { createTokenStore, TokenStoreError } from './token-store.js';
import { createMainWindow, rendererIndexPath } from './window.js';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const urls: AppUrlOptions = { devServerUrl, rendererIndexPath: rendererIndexPath() };
const log = (message: string) => console.info(`[desktop] ${message}`);

/** safeStorage-encrypted Ollama access token. Read only to hand it to the agent. */
const tokens = createTokenStore({
  safeStorage,
  filePath: join(app.getPath('userData'), 'ollama-token.bin'),
});

const agent = createAgentLink({
  stateFile: resolveAgentStateFile(process.env, app.getAppPath()),
  client: { kind: 'shell', version: app.getVersion() },
  log,
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    for (const [channel, handler] of Object.entries(createIpcHandlers({ agent, tokens }))) {
      ipcMain.handle(channel, async (event, raw: unknown) => {
        if (!fromApp(event)) throw new Error('Refused: not the app window.');
        try {
          return await handler(raw);
        } catch (error) {
          // Messages the operator can act on travel; anything else stays generic.
          if (error instanceof IpcInputError || error instanceof TokenStoreError) throw error;
          if (error instanceof AgentClientError) throw new Error(error.message, { cause: error });
          log(`${channel} failed.`);
          // Electron sends only the message to the renderer; the cause stays in main.
          throw new Error('The request failed.', { cause: error });
        }
      });
    }
    createMainWindow({ ...urls, allowDevTools: !app.isPackaged });
  });

  app.on('window-all-closed', () => {
    agent.close();
    app.quit();
  });
}
