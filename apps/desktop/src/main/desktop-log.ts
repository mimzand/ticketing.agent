import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The desktop log: main-process events and the agent child's output, one line each,
 * to the console and (when a path is given) to a file in the app's user data folder.
 * Every line is redacted before it is written. The child is copied through here, and
 * a library warning must not land a token or a bearer header in the file.
 */

const BEARER = /Bearer\s+\S+/gi;
const SECRET_ASSIGNMENT =
  /\b(OLLAMA_TOKEN|API_KEY|AUTHORIZATION|ACCESS_TOKEN|TOKEN)\b(\s*[:=]\s*["']?)[^\s"',}]+/gi;
/** Agent tokens are 43–128 unreserved characters. Shorter ids, such as UUIDs, stay. */
const LONG_SECRET = /\b[A-Za-z0-9_-]{43,}\b/g;

/** Removes bearer headers, secret assignments, and token-shaped strings from one line. */
export function redactSecrets(message: string): string {
  return message.replace(BEARER, 'Bearer [redacted]').replace(SECRET_ASSIGNMENT, '$1$2[redacted]').replace(LONG_SECRET, '[redacted]');
}

export interface DesktopLog {
  info(message: string): void;
  warn(message: string): void;
}

export function createDesktopLog(options: { readonly file?: string; readonly console?: boolean } = {}): DesktopLog {
  if (options.file) mkdirSync(dirname(options.file), { recursive: true });
  const write = (level: 'info' | 'warn', message: string) => {
    const safe = redactSecrets(message);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${safe}`;
    if (options.console !== false) {
      if (level === 'warn') console.warn(`[desktop] ${safe}`);
      else console.info(`[desktop] ${safe}`);
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
