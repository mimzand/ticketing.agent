import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The desktop log: main-process events and the agent child's output, one line each,
 * to the console and (when a path is given) to a file in the app's user data folder.
 * Callers pass fixed text and ids only: never a token, an API key, or ticket text.
 */
export interface DesktopLog {
  info(message: string): void;
  warn(message: string): void;
}

export function createDesktopLog(options: { readonly file?: string; readonly console?: boolean } = {}): DesktopLog {
  if (options.file) mkdirSync(dirname(options.file), { recursive: true });
  const write = (level: 'info' | 'warn', message: string) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    if (options.console !== false) {
      if (level === 'warn') console.warn(`[desktop] ${message}`);
      else console.info(`[desktop] ${message}`);
    }
    if (options.file) {
      try {
        appendFileSync(options.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Logging must never break the app.
      }
    }
  };
  return { info: (m) => write('info', m), warn: (m) => write('warn', m) };
}
