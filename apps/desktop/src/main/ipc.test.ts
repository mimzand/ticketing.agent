import { type AgentLink } from '@ticket/agent-client';
import { IpcChannels, SETTINGS_DEFAULTS, type SettingsView } from '@ticket/shared';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIpcHandlers } from './ipc.js';
import { createTokenStore, TOKEN_ENCRYPTION_UNAVAILABLE, type SafeStorageLike } from './token-store.js';

const TOKEN = 'secret-ollama-token-' + 'q'.repeat(30);
const TICKET_ID = '00000000-0000-4000-8000-000000000001';

/** Reversible stand-in for safeStorage: the file must not contain the plain token. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

function settingsView(tokenSet: boolean): SettingsView {
  const field = <T,>(value: T, envVar: 'OLLAMA_HOST' | 'OLLAMA_MODEL' | 'CLASSIFY_MIN_CONFIDENCE' | null = null) => ({
    value,
    source: 'default' as const,
    saved: null,
    envVar,
    envError: null,
  });
  return {
    fields: {
      ollamaBaseUrl: field(SETTINGS_DEFAULTS.ollamaBaseUrl, 'OLLAMA_HOST'),
      connectTimeoutMs: field(SETTINGS_DEFAULTS.connectTimeoutMs),
      model: field(SETTINGS_DEFAULTS.model, 'OLLAMA_MODEL'),
      classifyTimeoutMs: field(SETTINGS_DEFAULTS.classifyTimeoutMs),
      minConfidence: field(SETTINGS_DEFAULTS.minConfidence, 'CLASSIFY_MIN_CONFIDENCE'),
    },
    tokenSet,
  };
}

const ticket = {
  id: TICKET_ID,
  externalId: 'ext-1',
  subject: 'Invoice',
  body: 'Body',
  channel: 'email',
  createdAt: '2026-01-01T00:00:00.000Z',
  decision: { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', status: 'labeled' },
};
const department = { id: 'billing', name: 'Billing', description: '', active: true };

/** A fake agent that holds the token like the real one: in memory, never returned. */
function fakeAgent() {
  const requests: { method: string; params: unknown }[] = [];
  let agentToken: string | null = null;
  const answers: Record<string, (params: unknown) => unknown> = {
    'departments.list': () => [department],
    'departments.create': () => department,
    'departments.update': () => department,
    'departments.delete': () => ({ id: 'billing', deleted: true }),
    'tickets.classify': () => ticket,
    'tickets.list': () => [ticket],
    'tickets.override': () => ticket,
    'settings.get': () => settingsView(agentToken !== null),
    'settings.update': () => settingsView(agentToken !== null),
    'settings.setToken': (params) => {
      agentToken = (params as { token: string | null }).token;
      return { tokenSet: agentToken !== null };
    },
    'settings.testConnection': () => ({ ok: true, message: 'Connected.', modelCount: 1, tokenSent: true }),
    'models.list': () => ({ reachable: true, server: 'http://127.0.0.1:11434', models: [{ name: 'qwen3:8b', size: 1 }], message: '' }),
    'storage.info': () => ({ databasePath: '/data/tickets.db', departmentCount: 1, ticketCount: 1 }),
  };
  const agent: Pick<AgentLink, 'request' | 'ping'> = {
    request: (async (method: string, params: unknown) => {
      requests.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params);
    }) as AgentLink['request'],
    ping: async () => ({ pid: 1, version: '0.1.0', protocolVersion: 1 }),
  };
  return { agent, requests, agentToken: () => agentToken };
}

/** A valid input for every channel. */
const INPUTS: Record<string, unknown> = {
  [IpcChannels.createDepartment]: { id: 'billing', name: 'Billing', description: '' },
  [IpcChannels.updateDepartment]: { id: 'billing', name: 'Billing 2' },
  [IpcChannels.deleteDepartment]: { id: 'billing' },
  [IpcChannels.classifyTicket]: { externalId: 'ext-1', subject: 'Invoice', body: 'Body', channel: 'email' },
  [IpcChannels.overrideTicket]: { id: TICKET_ID, departmentId: 'billing' },
  [IpcChannels.updateSettings]: { minConfidence: 0.8 },
  [IpcChannels.testConnection]: { baseUrl: 'https://ollama.example.com' },
  [IpcChannels.saveOllamaToken]: TOKEN,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket-ipc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('IPC handlers', () => {
  it('the token is absent from every renderer payload', async () => {
    const { agent, agentToken } = fakeAgent();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 'token.bin'), platform: 'win32' });
    const handlers = createIpcHandlers({ agent, tokens });

    // Save first, so every later payload is produced while a token is set.
    const saved = await handlers[IpcChannels.saveOllamaToken](TOKEN);
    expect(saved).toEqual({ tokenSet: true });
    expect(agentToken()).toBe(TOKEN);

    const channels = Object.values(IpcChannels).filter((c) => c !== IpcChannels.clearOllamaToken);
    expect(channels.length).toBe(Object.keys(handlers).length - 1);
    for (const channel of channels) {
      const payload = await handlers[channel](INPUTS[channel]);
      const text = JSON.stringify(payload);
      expect(text, channel).not.toContain(TOKEN);
      expect(text, channel).not.toMatch(/"token"/i);
    }
    const view = (await handlers[IpcChannels.getSettings](undefined)) as { tokenSet: boolean };
    expect(view.tokenSet).toBe(true);

    expect(JSON.stringify(await handlers[IpcChannels.clearOllamaToken](undefined))).toBe('{"tokenSet":false}');
    expect(agentToken()).toBeNull();
  });

  it('stores the token encrypted on disk, never in plain text', async () => {
    const { agent } = fakeAgent();
    const filePath = join(dir, 'token.bin');
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), filePath, platform: 'win32' });
    await createIpcHandlers({ agent, tokens })[IpcChannels.saveOllamaToken](TOKEN);
    expect(readFileSync(filePath).toString('utf8')).not.toContain(TOKEN);
    expect(tokens.load()).toBe(TOKEN);
  });

  it('refuses to save the token when safeStorage cannot encrypt', async () => {
    const { agent, requests } = fakeAgent();
    const filePath = join(dir, 'token.bin');
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(false), filePath, platform: 'win32' });
    const handlers = createIpcHandlers({ agent, tokens });
    await expect(handlers[IpcChannels.saveOllamaToken](TOKEN)).rejects.toThrow(TOKEN_ENCRYPTION_UNAVAILABLE);
    expect(existsSync(filePath)).toBe(false);
    expect(requests.some((r) => r.method === 'settings.setToken')).toBe(false);
    const view = (await handlers[IpcChannels.getSettings](undefined)) as { tokenEncryptionAvailable: boolean };
    expect(view.tokenEncryptionAvailable).toBe(false);
  });

  it('treats the Linux basic_text backend as unable to encrypt', () => {
    const tokens = createTokenStore({
      safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' },
      filePath: join(dir, 'token.bin'),
      platform: 'linux',
    });
    expect(tokens.encryptionAvailable()).toBe(false);
  });

  it('does not send an invalid setting to the agent', async () => {
    const { agent, requests } = fakeAgent();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 't.bin'), platform: 'win32' });
    const handlers = createIpcHandlers({ agent, tokens });
    await expect(handlers[IpcChannels.updateSettings]({ ollamaBaseUrl: 'ftp://host' })).rejects.toThrow('Use http or https.');
    await expect(handlers[IpcChannels.updateSettings]({ minConfidence: 2 })).rejects.toThrow();
    await expect(handlers[IpcChannels.updateSettings]({ token: TOKEN })).rejects.toThrow();
    expect(requests.some((r) => r.method === 'settings.update')).toBe(false);
  });

  it('a department edit cannot change the id', async () => {
    const { agent, requests } = fakeAgent();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), filePath: join(dir, 't.bin'), platform: 'win32' });
    const handlers = createIpcHandlers({ agent, tokens });
    await expect(handlers[IpcChannels.updateDepartment]({ id: 'billing', newId: 'x' })).rejects.toThrow();
    await handlers[IpcChannels.updateDepartment]({ id: 'billing', active: false });
    expect(requests.at(-1)).toEqual({ method: 'departments.update', params: { id: 'billing', active: false } });
  });
});
