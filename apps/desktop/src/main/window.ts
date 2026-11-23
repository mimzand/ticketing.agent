import { join } from 'node:path';
import { BrowserWindow, type WebPreferences } from 'electron';
import { isAppUrl, type AppUrlOptions } from './security.js';

/** Built renderer entry. */
export const rendererIndexPath = (): string => join(import.meta.dirname, '../renderer/index.html');

/** Built preload (CommonJS: sandboxed preloads cannot be ES modules). */
export const preloadPath = (): string => join(import.meta.dirname, '../preload/index.cjs');

/**
 * Renderer isolation: no Node.js, sandboxed, isolated preload world, web security on.
 * The first four are the flags docs/context.md requires.
 */
export const ISOLATED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
} as const satisfies WebPreferences;

/** Matches `--bg` of the dark theme, so the window never flashes white before the first paint. */
export const DARK_BACKGROUND = '#111318';

export interface WindowOptions extends AppUrlOptions {
  readonly allowDevTools: boolean;
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: DARK_BACKGROUND,
    title: 'Ticketing Agent',
    autoHideMenuBar: true,
    webPreferences: {
      ...ISOLATED_WEB_PREFERENCES,
      preload: preloadPath(),
      devTools: options.allowDevTools,
    },
  });

  window.once('ready-to-show', () => window.show());

  // No new windows, and no navigation away from the app.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: { preventDefault(): void }, url: string) => {
    if (!isAppUrl(url, options)) event.preventDefault();
  };
  window.webContents.on('will-navigate', (event) => block(event, event.url));
  window.webContents.on('will-redirect', (event) => block(event, event.url));

  if (options.devServerUrl) void window.loadURL(options.devServerUrl);
  else void window.loadFile(options.rendererIndexPath);

  return window;
}
