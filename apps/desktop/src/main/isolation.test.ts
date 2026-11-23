/**
 * Architecture guards for the shell: the renderer has no network, the preload
 * exposes only the fixed window.api, and main talks to the agent, never to the HTTP API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CSP } from '../../electron.vite.config.js';

const srcDir = join(import.meta.dirname, '..');
const rendererDir = join(srcDir, 'renderer');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue|html)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function offenders(dir: string, patterns: RegExp[]): string[] {
  return sourceFiles(dir).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return patterns
      .filter((pattern) => pattern.test(text))
      .map((pattern) => `${relative(srcDir, file)}: ${pattern}`);
  });
}

describe('renderer isolation', () => {
  it('ships a CSP with no network access', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'none'");
    expect(PRODUCTION_CSP).toContain("default-src 'none'");
  });

  it('has no network calls, Node APIs, or Electron imports', () => {
    expect(
      offenders(rendererDir, [
        /\bfetch\s*\(/,
        /XMLHttpRequest/,
        /new\s+WebSocket/,
        /EventSource/,
        /sendBeacon/,
        /\brequire\s*\(/,
        /from\s+['"](node:|electron|@ticket\/agent-)/,
        /8787/,
      ]),
    ).toEqual([]);
  });
});

describe('preload', () => {
  it('exposes only the fixed window.api methods', () => {
    const text = readFileSync(join(srcDir, 'preload', 'index.ts'), 'utf8');
    const body = /const api: RendererApi = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
    const keys = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      'getHealth',
      'listDepartments',
      'createDepartment',
      'classifyTicket',
      'listTickets',
      'overrideTicket',
    ]);
    expect(text.match(/exposeInMainWorld/g)).toHaveLength(1);
  });
});

describe('main process', () => {
  it('reaches the agent through @ticket/agent-client, not the HTTP API', () => {
    expect(
      offenders(join(srcDir, 'main'), [/\bfetch\s*\(/, /8787/, /API_PORT|API_HOST|API_KEY/, /node:https?['"]/]),
    ).toEqual([]);
    const index = readFileSync(join(srcDir, 'main', 'index.ts'), 'utf8');
    expect(index).toMatch(/from '@ticket\/agent-client'/);
    expect(index).toMatch(/kind: 'shell'/);
  });
});
