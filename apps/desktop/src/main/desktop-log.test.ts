import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopLog, redactSecrets } from './desktop-log.js';

describe('redactSecrets', () => {
  it('removes bearer headers, secret assignments, and token-shaped strings', () => {
    const token = 'A'.repeat(48);
    const line = redactSecrets(
      `Authorization: Bearer ${token} OLLAMA_TOKEN=${token} API_KEY: ${token} raw ${token} pid 12`,
    );
    expect(line).not.toContain(token);
    expect(line).toContain('[redacted]');
    expect(line).toContain('pid 12');
  });
});

describe('createDesktopLog', () => {
  let dir: string;

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the redacted line, not the secret', () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-log-'));
    const file = join(dir, 'desktop.log');
    const token = 'B'.repeat(48);
    const log = createDesktopLog({ file, console: false });
    log.info(`header Bearer ${token}`);
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    expect(readFileSync(file, 'utf8')).toContain('Bearer [redacted]');
  });
});
