import { sanitizeAdkEnvironment } from '@ticket/adk-runtime';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openTicketDatabase } from '@ticket/storage';
import { loadPanelCatalogue } from './adk-panel/catalogue-load.js';
import { PanelCatalogueSchema } from './adk-panel/catalogue.js';
import { resolveTicketDatabasePath } from './run.js';

/** Loopback only. The panel has no authentication of its own. */
export const ADK_PANEL_HOST = '127.0.0.1';

/**
 * Kept outside the bundle so the panel and the devtools server share one copy
 * of ADK (its agent check is a module-local symbol) and one copy of Zod.
 */
export const PANEL_BUNDLE_EXTERNAL = ['@google/adk', '@google/adk/*', 'zod', 'zod/*'] as const;

export function adkPanelPort(env: NodeJS.ProcessEnv): string {
  const raw = env['ADK_WEB_PORT']?.trim();
  if (!raw) return '8000';
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error('ADK_WEB_PORT must be a TCP port.');
  const port = Number(raw);
  if (port > 65_535) throw new Error('ADK_WEB_PORT must be a TCP port.');
  return String(port);
}

/** Arguments for `@google/adk-devtools` `web`. In-memory sessions, no second bundle. */
export function adkWebArguments(cliPath: string, agentsDir: string, port: string): string[] {
  return [
    cliPath,
    'web',
    agentsDir,
    '--host',
    ADK_PANEL_HOST,
    '--port',
    port,
    '--session_service_uri',
    'memory://',
    '--compile',
    'false',
    '--bundle',
    'false',
  ];
}

export async function buildPanelBundle(outfile: string): Promise<void> {
  await build({
    entryPoints: [resolve(import.meta.dirname, 'adk-panel/classifier/agent.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [...PANEL_BUNDLE_EXTERNAL],
    logLevel: 'warning',
  });
}

function adkCliPath(): string {
  let dir = import.meta.dirname;
  for (;;) {
    const packageJsonPath = join(dir, 'node_modules', '@google', 'adk-devtools', 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: { adk?: string } };
      const bin = pkg.bin?.adk;
      if (!bin) throw new Error('The ADK devtools package has no adk command.');
      return join(dirname(packageJsonPath), bin);
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot find @google/adk-devtools. Run yarn install.');
    dir = parent;
  }
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  sanitizeAdkEnvironment(env);
  const port = adkPanelPort(env);
  const db = openTicketDatabase(resolveTicketDatabasePath(env));
  let catalogue;
  try {
    catalogue = PanelCatalogueSchema.parse(loadPanelCatalogue(db, env));
  } finally {
    db.close();
  }

  const dataDir = resolve(import.meta.dirname, '..', '.data');
  mkdirSync(dataDir, { recursive: true });
  const dir = mkdtempSync(join(dataDir, 'adk-panel-'));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  let child: ChildProcess | undefined;
  const stop = () => child?.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const snapshotPath = join(dir, 'catalogue.json');
    writeFileSync(snapshotPath, JSON.stringify(catalogue), { encoding: 'utf8' });
    env['TICKET_ADK_PANEL_SNAPSHOT'] = snapshotPath;
    await buildPanelBundle(join(dir, 'classifier', 'agent.js'));
    const cliPath = adkCliPath();
    console.info(`[adk] Panel: http://${ADK_PANEL_HOST}:${port}`);
    console.info(
      `[adk] ${catalogue.departments.length} active departments, ${catalogue.categories.categories.length} active categories. The catalogue is a snapshot from this start.`,
    );
    console.info(
      env['OLLAMA_TOKEN']?.trim()
        ? '[adk] Ollama token: OLLAMA_TOKEN from the environment.'
        : '[adk] Ollama token: none. A token saved in the desktop app is not read here.',
    );
    child = spawn(process.execPath, adkWebArguments(cliPath, dir, port), {
      cwd: dir,
      env,
      stdio: 'inherit',
    });
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child?.once('error', reject);
      child?.once('exit', (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
    });
    remove();
    process.exit(exitCode);
  } catch (error) {
    stop();
    remove();
    throw error;
  }
}

function startedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (startedAsScript()) {
  main().catch((error: unknown) => {
    console.error(`[adk] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
