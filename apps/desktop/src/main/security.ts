import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppUrlOptions {
  /** electron-vite dev server URL (development only). */
  readonly devServerUrl: string | undefined;
  /** Absolute path of the built renderer's index.html. */
  readonly rendererIndexPath: string;
}

/**
 * True when a URL is our own renderer: in development only the dev server origin,
 * otherwise only the built index.html.
 */
export function isAppUrl(url: string, options: AppUrlOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (options.devServerUrl) {
    try {
      return parsed.origin === new URL(options.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== 'file:') return false;
  try {
    const norm = (p: string) => resolve(p).replace(/\\/g, '/');
    const a = norm(fileURLToPath(parsed));
    const b = norm(options.rendererIndexPath);
    // Windows paths are case-insensitive.
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
