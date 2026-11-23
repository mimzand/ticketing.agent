// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/*
 * Architecture boundaries from docs/context.md ("Packages"), enforced with
 * no-restricted-imports. Phase 2 packages (storage, model-provider, adk-runtime,
 * agent-host) are named here already so the rules hold when they arrive.
 */

const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'readline', 'stream', 'tls', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
];

/** @param {string} message */
const nodeBan = (message) => ({
  paths: NODE_BUILTINS.map((name) => ({ name, message })),
  patterns: [{ group: ['node:*'], message }],
});

/**
 * @param {string} message
 * @param {string[]} group
 */
const ban = (message, group) => ({ group, message });

const ELECTRON = (/** @type {string} */ message) => ({ name: 'electron', message });

/** Every workspace package is imported through its one entry point. */
const DEEP_IMPORT = ban('Import workspace packages through their entry point only (no deep imports).', [
  '@ticket/*/*',
]);
/** No reaching into another workspace's files by relative path. */
const CROSS_WORKSPACE = ban('Do not import another workspace by path; use its package name.', [
  '**/packages/*/src/**',
  '**/apps/*/src/**',
  '../../packages/**',
  '../../../packages/**',
  '../../apps/**',
  '../../../apps/**',
  '../agent/**',
  '../api/**',
  '../desktop/**',
]);

const PHASE2 = ['@ticket/storage', '@ticket/model-provider', '@ticket/adk-runtime', '@ticket/agent-host'];
const SQLITE_AND_ADK = ['better-sqlite3', 'drizzle-orm', 'drizzle-orm/*', '@google/adk', '@google/adk/*'];
const APPS = ['@ticket/agent', '@ticket/api', '@ticket/desktop'];
/** Eval tooling sits on top of the host; no package or app imports it. */
const NO_EVAL = ban('@ticket/eval is a dev tool: no package or app imports it.', ['@ticket/eval']);

/**
 * One no-restricted-imports rule for a set of files.
 * @param {string[]} files
 * @param {{ paths?: object[], patterns?: object[] }} spec
 * @param {string[]} [ignores]
 */
const boundary = (files, spec, ignores) => ({
  files,
  ...(ignores && { ignores }),
  rules: {
    'no-restricted-imports': [
      'error',
      { paths: spec.paths ?? [], patterns: [DEEP_IMPORT, NO_EVAL, ...(spec.patterns ?? [])] },
    ],
  },
});

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/coverage/**', '.yarn/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  ...vue.configs['flat/recommended'],

  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: globals.browser,
    },
  },

  // Node-side code.
  {
    files: [
      '*.{js,ts}',
      'test/**/*.ts',
      'apps/*/*.{js,ts}',
      'apps/*/scripts/**/*.{js,mjs}',
      'apps/agent/src/**/*.ts',
      'apps/api/src/**/*.ts',
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'packages/*/*.{js,ts}',
      'packages/*/src/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  { files: ['apps/desktop/src/renderer/**/*.{ts,vue,js}'], languageOptions: { globals: globals.browser } },
  // The theme boot file is a classic <script> that runs before the first paint.
  { files: ['apps/desktop/src/renderer/public/**/*.js'], languageOptions: { sourceType: 'script' } },

  // ---------------------------------------------------------------- packages

  // @ticket/shared: no Node, no Electron, no other workspace packages.
  boundary(['packages/shared/src/**/*.ts'], {
    paths: [...nodeBan('@ticket/shared is platform-neutral: no Node APIs.').paths, ELECTRON('Packages stay Electron-agnostic.')],
    patterns: [
      ...nodeBan('@ticket/shared is platform-neutral: no Node APIs.').patterns,
      ban('@ticket/shared must not depend on other workspace packages.', ['@ticket/*']),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/agent-protocol: only @ticket/shared, no Node APIs.
  boundary(['packages/agent-protocol/src/**/*.ts'], {
    paths: [...nodeBan('@ticket/agent-protocol uses no Node APIs.').paths, ELECTRON('Packages stay Electron-agnostic.')],
    patterns: [
      ...nodeBan('@ticket/agent-protocol uses no Node APIs.').patterns,
      ban('@ticket/agent-protocol depends only on @ticket/shared.', [
        '@ticket/agent-client', ...PHASE2, ...APPS, ...SQLITE_AND_ADK,
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/agent-client: the protocol (+ shared). Never Electron.
  boundary(['packages/agent-client/src/**/*.ts'], {
    paths: [ELECTRON('@ticket/agent-client never imports electron.')],
    patterns: [
      ban('@ticket/agent-client depends only on @ticket/agent-protocol and @ticket/shared.', [
        ...PHASE2, ...APPS, ...SQLITE_AND_ADK,
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/model-provider: only @ticket/shared. No SQLite, no ADK.
  boundary(['packages/model-provider/src/**/*.ts'], {
    paths: [ELECTRON('Packages stay Electron-agnostic.')],
    patterns: [
      ban('This package depends only on @ticket/shared.', [
        '@ticket/agent-protocol', '@ticket/agent-client', ...PHASE2, ...APPS,
      ]),
      ban('SQLite and ADK stay in their own packages.', SQLITE_AND_ADK),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/storage: @ticket/shared plus better-sqlite3 and Drizzle. No ADK.
  boundary(['packages/storage/src/**/*.ts'], {
    paths: [ELECTRON('Packages stay Electron-agnostic.')],
    patterns: [
      ban('This package depends only on @ticket/shared.', [
        '@ticket/agent-protocol', '@ticket/agent-client', ...PHASE2, ...APPS,
      ]),
      ban('ADK stays in @ticket/adk-runtime.', ['@google/adk', '@google/adk/*']),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/adk-runtime: shared + model-provider, and the only @google/adk import.
  boundary(['packages/adk-runtime/src/**/*.ts'], {
    paths: [ELECTRON('Packages stay Electron-agnostic.')],
    patterns: [
      ban('@ticket/adk-runtime depends only on @ticket/shared and @ticket/model-provider.', [
        '@ticket/agent-protocol',
        '@ticket/agent-client',
        '@ticket/storage',
        '@ticket/agent-host',
        ...APPS,
        'better-sqlite3',
        'drizzle-orm',
        'drizzle-orm/*',
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/agent-host composes storage, the model provider, and the ADK runtime.
  boundary(['packages/agent-host/src/**/*.ts'], {
    paths: [ELECTRON('@ticket/agent-host never imports electron.')],
    patterns: [
      ban('@ticket/agent-host does not import ADK, SQLite, the protocol, or an app.', [
        '@ticket/agent-protocol',
        '@ticket/agent-client',
        ...APPS,
        ...SQLITE_AND_ADK,
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // @ticket/eval: drives createAgentHost with a fake Ollama. It may use the host, storage
  // (to open a temp database), and shared; never ADK, SQLite directly, the protocol, or an app.
  boundary(['packages/eval/src/**/*.ts'], {
    paths: [ELECTRON('@ticket/eval never imports electron.')],
    patterns: [
      ban('@ticket/eval uses only @ticket/agent-host, @ticket/storage, and @ticket/shared.', [
        '@ticket/agent-protocol',
        '@ticket/agent-client',
        '@ticket/adk-runtime',
        '@ticket/model-provider',
        ...APPS,
        ...SQLITE_AND_ADK,
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // ---------------------------------------------------------------- apps

  // apps/agent: plain Node, never Electron, never the desktop or the API.
  boundary(['apps/agent/src/**/*.ts'], {
    paths: [ELECTRON('The agent service runs without Electron.')],
    patterns: [
      ban('The agent service never imports the shell, the API, or the agent client.', [
        '@ticket/desktop', '@ticket/api', '@ticket/agent-client',
      ]),
      ban('The agent service reaches ADK and SQLite only through their packages.', SQLITE_AND_ADK),
      CROSS_WORKSPACE,
    ],
  }),

  // apps/api: only @ticket/shared and @ticket/agent-client. No database, no ADK, no Electron.
  boundary(['apps/api/src/**/*.ts'], {
    paths: [ELECTRON('The HTTP API runs without Electron.')],
    patterns: [
      ban('The API reaches the agent only through @ticket/agent-client.', [
        '@ticket/agent-protocol', ...PHASE2, ...APPS, ...SQLITE_AND_ADK,
      ]),
      CROSS_WORKSPACE,
    ],
  }),

  // Electron main: @ticket/agent-client and @ticket/shared. Not the renderer or preload folders.
  boundary(['apps/desktop/src/main/**/*.ts'], {
    patterns: [
      ban('Electron main talks to the agent through @ticket/agent-client only.', [
        '@ticket/agent-protocol', ...PHASE2, '@ticket/agent', '@ticket/api', ...SQLITE_AND_ADK,
      ]),
      ban('Do not import across Electron process folders.', ['**/preload/**', '**/renderer/**']),
      CROSS_WORKSPACE,
    ],
  }),

  // Preload: electron + @ticket/shared only.
  boundary(['apps/desktop/src/preload/**/*.ts'], {
    paths: nodeBan('The preload is sandboxed: no Node APIs.').paths,
    patterns: [
      ...nodeBan('The preload is sandboxed: no Node APIs.').patterns,
      ban('The preload may import only electron and @ticket/shared.', [
        '@ticket/agent-protocol', '@ticket/agent-client', ...PHASE2, ...APPS, ...SQLITE_AND_ADK,
      ]),
      ban('Do not import across Electron process folders.', ['**/main/**', '**/renderer/**']),
      CROSS_WORKSPACE,
    ],
  }),

  // Renderer: browser code, @ticket/shared only, reaches main only through window.api.
  boundary(['apps/desktop/src/renderer/**/*.{ts,vue,js}'], {
    paths: [
      ...nodeBan('The renderer has no Node.').paths,
      ELECTRON('The renderer uses window.api (preload bridge).'),
    ],
    patterns: [
      ...nodeBan('The renderer has no Node.').patterns,
      ban('The renderer may import only @ticket/shared.', [
        '@ticket/agent-protocol', '@ticket/agent-client', ...PHASE2, ...APPS, ...SQLITE_AND_ADK,
      ]),
      ban('Do not import across Electron process folders.', ['**/main/**', '**/preload/**']),
      CROSS_WORKSPACE,
    ],
  }),

  // Only apps/desktop may import electron.
  {
    files: ['packages/*/src/**/*.ts', 'apps/agent/**/*.ts', 'apps/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression > Literal[value='electron']",
          message: 'Only apps/desktop may import electron.',
        },
      ],
    },
  },

  prettier,
);
