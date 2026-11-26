import { createServer, type Server } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeOllama } from './fake-ollama.js';
import { GOLDEN_DIR } from './load.js';
import { recordCase, type RecordInput } from './record.js';
import { SuiteFileSchema } from './suite.js';

const TOKEN = 'SENTINEL-RECORD-TOKEN-' + 'z'.repeat(24);
const URL_SENTINEL = 'http://ollama.record-sentinel.test:11434';
const RAW = '  {"departmentId": "it",\n "confidence": 0.86, "rationale": "VPN.", "quote": "VPN drops", "categoryId": "outage", "priority": "high"}\n';

const input = (extra: Partial<RecordInput> = {}): RecordInput => ({
  suite: 'recorded',
  caseId: 'vpn-drops',
  description: 'A synthetic VPN ticket.',
  threshold: 0.7,
  departments: [
    { id: 'billing', name: 'Billing', description: 'Invoices' },
    { id: 'it', name: 'IT', description: 'VPN and laptops' },
  ],
  categories: [{ id: 'outage', name: 'Outage', description: 'Down', defaultPriority: 'urgent' }],
  ticket: { externalId: 'rec-1', subject: 'VPN drops every hour', body: 'Synthetic body.', channel: 'email' },
  expect: { status: 'labeled', departmentId: 'it', categoryId: 'outage', priority: 'high' },
  ...extra,
});

describe('recordCase', () => {
  it('runs the real host path and keeps the raw answer exactly, with the human expectation', async () => {
    const fake = createFakeOllama([{ kind: 'recorded', content: RAW }]);
    const result = await recordCase(input(), {
      env: { OLLAMA_HOST: URL_SENTINEL, OLLAMA_MODEL: 'live-model', OLLAMA_TOKEN: TOKEN, OLLAMA_FALLBACK_MODEL: 'other' },
      fetch: fake.fetch,
    });
    expect(result.problems).toEqual([]);
    expect(result.actual).toMatchObject({ status: 'labeled', departmentId: 'it', categoryId: 'outage', priority: 'high' });
    // The real instruction was built (catalogue in the system message, ticket in the user message).
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.system).toContain('- id: outage');
    expect(fake.requests[0]?.system).not.toContain('VPN drops every hour');
    expect(fake.requests[0]?.user).toContain('VPN drops every hour');

    const file = SuiteFileSchema.parse(result.file);
    const [recorded] = file.cases;
    expect(recorded?.reply).toEqual({ kind: 'recorded', content: RAW, model: 'live-model', recordedAt: expect.any(String) as string });
    expect(recorded?.expect).toEqual(input().expect);
    expect(recorded?.source).toBe('golden');
    expect(recorded?.ticket).not.toHaveProperty('email');
    const text = JSON.stringify(result.file);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('record-sentinel');
  });

  it('never replaces the expectation with the live answer', async () => {
    const fake = createFakeOllama([{ kind: 'recorded', content: RAW }]);
    const result = await recordCase(input({ expect: { status: 'labeled', departmentId: 'billing', priority: 'low' } }), {
      env: { OLLAMA_MODEL: 'live-model' },
      fetch: fake.fetch,
    });
    expect(result.problems).toEqual(['department it, expected billing', 'priority high, expected low']);
    expect(result.file?.cases[0]?.expect).toEqual({ status: 'labeled', departmentId: 'billing', priority: 'low' });
  });

  it('refuses a sender email and an input without an expectation', async () => {
    const withEmail = { ...input(), ticket: { ...input().ticket, email: 'someone@example.com' } };
    await expect(recordCase(withEmail, { env: {} })).rejects.toThrow(/no email/);
    const { expect: _expect, ...noExpect } = input();
    await expect(recordCase(noExpect, { env: {} })).rejects.toThrow();
  });

  it('writes nothing when the model gives no answer', async () => {
    const fake = createFakeOllama([{ kind: 'error', status: 400 }]);
    const result = await recordCase(input(), { env: {}, fetch: fake.fetch });
    expect(result.file).toBeNull();
    expect(result.actual.status).toBe('failed');
  });
});

describe('record CLI', () => {
  const packageDir = join(import.meta.dirname, '..');
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    const current = server;
    server = undefined;
    if (current) await new Promise<void>((r) => current.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const cliSync = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'record', ...args], {
      cwd: packageDir,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], PROJECT_CWD: packageDir, ...env },
    });
  /** Async, so the fake Ollama in this process can answer while the CLI runs. */
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'record', ...args], {
        cwd: packageDir,
        env: { PATH: process.env['PATH'], PROJECT_CWD: packageDir, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  async function ollama(content: string): Promise<string> {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/tags' ? { models: [] } : { message: { role: 'assistant', content } }));
      });
    });
    return new Promise((resolve) =>
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address !== 'string') resolve(`http://127.0.0.1:${address.port}`);
      }),
    );
  }

  function files(record: unknown = input()) {
    dir = mkdtempSync(join(tmpdir(), 'ticket-record-cli-'));
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify(record));
    return { inputPath, outputPath: join(dir, 'draft.json') };
  }

  it('refuses to run without --synthetic, with an email, or into the golden folder', () => {
    const { inputPath, outputPath } = files();
    const missing = cliSync([inputPath, outputPath]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/pass --synthetic/);
    expect(existsSync(outputPath)).toBe(false);

    const email = files({ ...input(), ticket: { ...input().ticket, email: 'someone@example.com' } });
    const refused = cliSync([email.inputPath, email.outputPath, '--synthetic']);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/no email/);

    const golden = cliSync([inputPath, join(GOLDEN_DIR, 'never-written.json'), '--synthetic']);
    expect(golden.status).toBe(2);
    expect(existsSync(join(GOLDEN_DIR, 'never-written.json'))).toBe(false);
  });

  it('records a live answer into a new draft, with no token or server URL in the output', async () => {
    const url = await ollama(RAW);
    const { inputPath, outputPath } = files();
    const env = { OLLAMA_HOST: url, OLLAMA_MODEL: 'live-model', OLLAMA_TOKEN: TOKEN };
    const result = await cli([inputPath, outputPath, '--synthetic'], env);
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(outputPath, 'utf8');
    const file = SuiteFileSchema.parse(JSON.parse(written));
    expect(file.cases[0]?.reply).toMatchObject({ kind: 'recorded', content: RAW, model: 'live-model' });
    for (const text of [written, result.stdout, result.stderr]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(url);
      expect(text).not.toContain('VPN drops every hour\n');
    }
    expect(result.stdout).toMatch(/department +expected it +actual it/);

    // Never overwrites an existing file.
    const again = await cli([inputPath, outputPath, '--synthetic'], env);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  }, 60_000);

  it('writes the draft but exits non-zero when the live answer misses the expectation', async () => {
    const url = await ollama(RAW);
    const { inputPath, outputPath } = files(input({ expect: { status: 'labeled', departmentId: 'billing' } }));
    const result = await cli([inputPath, outputPath, '--synthetic'], { OLLAMA_HOST: url, OLLAMA_MODEL: 'live-model' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/The expected value was not changed/);
    expect(result.stdout).toMatch(/differs/);
    const file = SuiteFileSchema.parse(JSON.parse(readFileSync(outputPath, 'utf8')));
    expect(file.cases[0]?.expect).toEqual({ status: 'labeled', departmentId: 'billing' });
  }, 60_000);
});
