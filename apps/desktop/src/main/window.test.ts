import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Captures what createMainWindow passes to `new BrowserWindow(...)`. */
const created = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    constructor(options: unknown) {
      created.options.push(options);
    }
    once = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
  }
  return { BrowserWindow };
});

const { createMainWindow } = await import('./window.js');

describe('createMainWindow', () => {
  beforeEach(() => {
    created.options.length = 0;
  });

  it('uses the four isolation flags from the context', () => {
    createMainWindow({
      devServerUrl: undefined,
      rendererIndexPath: '/app/out/renderer/index.html',
      allowDevTools: false,
    });
    expect(created.options).toHaveLength(1);
    const { webPreferences } = created.options[0] as { webPreferences: Record<string, unknown> };
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(webPreferences['preload']).toMatch(/preload[\\/]index\.cjs$/);
    expect(webPreferences['devTools']).toBe(false);
  });

  it('denies every new window', () => {
    const window = createMainWindow({
      devServerUrl: 'http://127.0.0.1:5173',
      rendererIndexPath: '/app/out/renderer/index.html',
      allowDevTools: true,
    });
    const setHandler = vi.mocked(window.webContents.setWindowOpenHandler);
    const handler = setHandler.mock.calls[0]?.[0] as unknown as () => unknown;
    expect(handler()).toEqual({ action: 'deny' });
  });
});
