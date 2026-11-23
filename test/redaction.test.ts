/**
 * Log redaction, end to end: a hello, a classify, and a token handoff through the
 * supervised agent (a real apps/agent process), the desktop IPC handlers, and the
 * HTTP API. Neither the agent's own output nor the desktop log may contain the agent
 * token, the API key, or the Ollama token.
 */
import { connectFromStateFile, createAgentLink, readStateFile } from '@ticket/agent-client';
import { IpcChannels } from '@ticket/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../apps/api/src/index.js';
import { AGENT_SOURCE_ENTRY, exitOf, fakeOllama, tsxFork } from '../apps/desktop/src/main/agent.fixture.js';
import { createAgentSupervisor } from '../apps/desktop/src/main/agent-supervisor.js';
import { createDesktopLog } from '../apps/desktop/src/main/desktop-log.js';
import { createIpcHandlers } from '../apps/desktop/src/main/ipc.js';
import { createTokenStore } from '../apps/desktop/src/main/token-store.js';

const dir = mkdtempSync(join(tmpdir(), 'ticket-redaction-'));
const API_KEY = 'apikey_' + 'K'.repeat(32);
const OLLAMA_TOKEN = 'ollamatok_' + 'T'.repeat(32);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('log redaction', () => {
  it('keeps the agent token, the API key, and the Ollama token out of the agent output and the desktop log', async () => {
    const ollama = await fakeOllama();
    const recorder = tsxFork();
    const stateFile = join(dir, 'agent-state.json');
    const logFile = join(dir, 'desktop.log');
    const apiLog: string[] = [];
    const log = createDesktopLog({ file: logFile, console: false });
    const supervisor = createAgentSupervisor({
      fork: recorder.fork,
      entry: AGENT_SOURCE_ENTRY,
      stateFile,
      databaseFile: join(dir, 'tickets.db'),
      // As if the app were started from the same shell as the API.
      env: { ...process.env, OLLAMA_HOST: ollama.url, OLLAMA_MODEL: 'test-model', API_KEY },
      parentPid: process.pid,
      appVersion: '0.0.0-test',
      log,
    });
    const shell = createAgentLink({
      stateFile,
      client: { kind: 'shell', version: '0.0.0-test' },
      log: (message) => log.info(message),
      connect: async (path, options) => {
        await supervisor.ensure();
        return connectFromStateFile(path, options);
      },
    });
    const cli = createAgentLink({ stateFile, client: { kind: 'cli', version: '0.0.0-test' }, log: (m) => apiLog.push(m) });
    try {
      // Hello (the handshake carries the agent token).
      await shell.ping();
      const read = readStateFile(stateFile);
      if (read.status !== 'ok') throw new Error('no state file');
      const agentToken = read.state.token;

      // Token handoff: renderer → main (encrypted at rest) → agent memory.
      const tokens = createTokenStore({
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
          decryptString: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
        },
        filePath: join(dir, 'token.bin'),
        platform: 'win32',
      });
      const handlers = createIpcHandlers({ agent: shell, tokens, supervisor });
      expect(await handlers[IpcChannels.saveOllamaToken](OLLAMA_TOKEN)).toEqual({ tokenSet: true });
      await handlers[IpcChannels.createDepartment]({ id: 'billing', name: 'Billing', description: '' });

      // Classify from the desktop and through the HTTP API (with the API key).
      await handlers[IpcChannels.classifyTicket]({ externalId: 'd-1', subject: 'Invoice', body: 'x', channel: 'email' });
      const api = createApiApp({ agent: cli, apiKey: API_KEY, log: (m) => apiLog.push(m) });
      const response = await api.request('/v1/tickets:classify', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ externalId: 'a-1', subject: 'Invoice', body: 'y', channel: 'api' }),
      });
      expect(response.status).toBe(200);
      // A wrong key and a refused token handoff are logged paths too.
      expect((await api.request('/v1/tickets', { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
      await expect(cli.request('settings.setToken', { token: OLLAMA_TOKEN })).rejects.toMatchObject({ code: 'forbidden' });

      // The handoff really happened: the Ollama token reached Ollama (loopback).
      expect(ollama.chats.map((c) => c.headers.authorization)).toContain(`Bearer ${OLLAMA_TOKEN}`);

      shell.close();
      cli.close();
      await supervisor.stop();

      const agentOutput = recorder.output();
      const desktopLog = readFileSync(logFile, 'utf8');
      expect(agentOutput).toMatch(/Client authenticated \(shell\)/);
      expect(desktopLog).toMatch(/Agent started by the desktop/);
      for (const [name, secret] of [
        ['agent token', agentToken],
        ['API key', API_KEY],
        ['Ollama token', OLLAMA_TOKEN],
      ] as const) {
        expect(agentOutput, `${name} in agent output`).not.toContain(secret);
        expect(desktopLog, `${name} in desktop log`).not.toContain(secret);
        expect(apiLog.join('\n'), `${name} in API log`).not.toContain(secret);
      }
    } finally {
      shell.close();
      cli.close();
      await supervisor.stop();
      for (const child of recorder.children) {
        child.kill('SIGKILL');
        await exitOf(child);
      }
      await ollama.close();
    }
  }, 90_000);
});
