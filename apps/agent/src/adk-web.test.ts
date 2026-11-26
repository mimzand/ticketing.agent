import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adkPanelPort, adkWebArguments, ADK_PANEL_HOST, buildPanelBundle } from './adk-web.js';

describe('adk web command', () => {
  it('binds to loopback and keeps sessions in memory', () => {
    expect(adkPanelPort({})).toBe('8000');
    expect(adkPanelPort({ ADK_WEB_PORT: '3000' })).toBe('3000');
    expect(() => adkPanelPort({ ADK_WEB_PORT: '0' })).toThrow(/TCP port/);
    expect(() => adkPanelPort({ ADK_WEB_PORT: 'nope' })).toThrow(/TCP port/);
    const args = adkWebArguments('adk.js', 'C:\\agents', '8000');
    expect(args).toContain('--host');
    expect(args).toContain(ADK_PANEL_HOST);
    expect(args).toContain('--session_service_uri');
    expect(args).toContain('memory://');
    expect(args).toContain('--bundle');
    expect(args).toContain('false');
    expect(args).not.toContain('0.0.0.0');
  });
});

describe('buildPanelBundle', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('leaves @google/adk as an import instead of copying it into the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-adk-bundle-'));
    const outfile = join(dir, 'classifier', 'agent.js');
    await buildPanelBundle(outfile);
    const source = readFileSync(outfile, 'utf8');
    expect(source).toMatch(/from ["']@google\/adk["']/);
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('BASE_AGENT_SIGNATURE');
    expect(source.length).toBeLessThan(1_500_000);
  });
});
