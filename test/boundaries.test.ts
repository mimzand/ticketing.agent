/**
 * ESLint enforces the package graph from docs/context.md. Each case lints a one-line
 * snippet as if it lived at `file` and expects no-restricted-imports to fire (or not).
 */
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const eslint = new ESLint({ cwd: root });

async function restricted(file: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(`${code}\nexport {};\n`, { filePath: resolve(root, file) });
  return (result?.messages ?? []).some((m) =>
    ['no-restricted-imports', 'no-restricted-syntax'].includes(m.ruleId ?? ''),
  );
}

describe('ESLint boundaries', () => {
  it.each([
    ['apps/api/src/x.ts', "import '@ticket/shared/src/health.js';", 'deep import of a package'],
    ['apps/desktop/src/main/x.ts', "import '@ticket/agent-client/src/client.js';", 'deep import of a package'],
    ['apps/api/src/x.ts', "import '../../../packages/shared/src/index.js';", 'relative import into another workspace'],
    ['packages/shared/src/x.ts', "import 'node:fs';", 'Node in @ticket/shared'],
    ['packages/shared/src/x.ts', "import '@ticket/agent-protocol';", 'shared depending on a workspace package'],
    ['packages/agent-protocol/src/x.ts', "import 'node:net';", 'Node in the protocol'],
    ['packages/agent-protocol/src/x.ts', "import '@ticket/agent-client';", 'protocol depending on the client'],
    ['packages/agent-client/src/x.ts', "import 'electron';", 'electron in the client'],
    ['apps/agent/src/x.ts', "import 'electron';", 'electron in the agent'],
    ['apps/agent/src/x.ts', "await import('electron');", 'dynamic electron import in the agent'],
    ['apps/api/src/x.ts', "import 'electron';", 'electron in the API'],
    ['apps/api/src/x.ts', "import '@ticket/agent-protocol';", 'API bypassing the agent client'],
    ['apps/api/src/x.ts', "import '@ticket/agent';", 'API importing the agent'],
    ['apps/api/src/x.ts', "import 'better-sqlite3';", 'API opening SQLite'],
    ['apps/api/src/x.ts', "import '@google/adk';", 'API importing ADK'],
    ['apps/desktop/src/main/x.ts', "import '@ticket/agent-protocol';", 'main bypassing the agent client'],
    ['apps/desktop/src/main/x.ts', "import '../renderer/src/App.vue';", 'main importing the renderer'],
    ['apps/desktop/src/preload/x.ts', "import '@ticket/agent-client';", 'preload importing the client'],
    ['apps/desktop/src/preload/x.ts', "import 'node:fs';", 'Node in the preload'],
    ['apps/desktop/src/renderer/src/x.ts', "import 'electron';", 'electron in the renderer'],
    ['apps/desktop/src/renderer/src/x.ts', "import 'node:path';", 'Node in the renderer'],
    ['apps/desktop/src/renderer/src/x.ts', "import '@ticket/agent-client';", 'client in the renderer'],
    ['apps/desktop/src/renderer/src/x.ts', "import '@ticket/agent-protocol';", 'protocol in the renderer'],
    ['packages/adk-runtime/src/x.ts', "import '@ticket/storage';", 'storage inside the ADK package'],
    ['packages/adk-runtime/src/x.ts', "import 'better-sqlite3';", 'SQLite inside the ADK package'],
    ['packages/agent-host/src/x.ts', "import '@google/adk';", 'ADK outside adk-runtime'],
    ['packages/model-provider/src/x.ts', "import '@ticket/adk-runtime';", 'the provider depending on ADK'],
    ['apps/agent/src/x.ts', "import '@google/adk';", 'the agent importing ADK directly'],
    ['packages/eval/src/x.ts', "import '@google/adk';", 'ADK in the eval tooling'],
    ['packages/eval/src/x.ts', "import 'better-sqlite3';", 'SQLite directly in the eval tooling'],
    ['packages/eval/src/x.ts', "import '@ticket/agent-client';", 'the eval tooling talking to a live agent'],
    ['packages/agent-host/src/x.ts', "import '@ticket/eval';", 'the host importing the eval tooling'],
    ['apps/api/src/x.ts', "import '@ticket/eval';", 'an app importing the eval tooling'],
  ])('rejects %s: %s (%s)', async (file, code) => {
    expect(await restricted(file, code)).toBe(true);
  });

  it.each([
    ['packages/agent-protocol/src/x.ts', "import '@ticket/shared';"],
    ['packages/agent-client/src/x.ts', "import '@ticket/agent-protocol';"],
    ['apps/agent/src/x.ts', "import '@ticket/agent-protocol';"],
    ['apps/api/src/x.ts', "import '@ticket/agent-client';"],
    ['apps/api/src/x.ts', "import '@ticket/shared';"],
    ['apps/desktop/src/main/x.ts', "import '@ticket/agent-client';"],
    ['apps/desktop/src/main/x.ts', "import 'electron';"],
    ['apps/desktop/src/preload/x.ts', "import 'electron';"],
    ['apps/desktop/src/renderer/src/x.ts', "import '@ticket/shared';"],
    ['packages/adk-runtime/src/x.ts', "import '@google/adk';"],
    ['packages/adk-runtime/src/x.ts', "import '@ticket/model-provider';"],
    ['packages/agent-host/src/x.ts', "import '@ticket/adk-runtime';"],
    ['packages/agent-host/src/x.ts', "import '@ticket/storage';"],
    ['apps/agent/src/x.ts', "import '@ticket/agent-host';"],
    ['packages/eval/src/x.ts', "import '@ticket/agent-host';"],
    ['packages/eval/src/x.ts', "import '@ticket/storage';"],
  ])('allows %s: %s', async (file, code) => {
    expect(await restricted(file, code)).toBe(false);
  });
});
