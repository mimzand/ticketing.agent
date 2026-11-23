#!/usr/bin/env node
/*
 * Builds the agent service for the desktop: apps/agent/src/main.ts →
 * apps/desktop/out/agent/main.js, the ES module Electron main forks with
 * utilityProcess (src/main/agent-supervisor.ts).
 *
 * Only the workspace sources (@ticket/*) are bundled. Every npm dependency (Zod,
 * Drizzle, better-sqlite3, @google/adk, …) stays external and loads from
 * node_modules, exactly as `yarn agent:dev` loads it. better-sqlite3 is a Node-API
 * addon, so the same binary loads in Electron's utility process.
 *
 * The Drizzle migrations are copied next to the bundle (out/agent/drizzle).
 * `yarn agent:dev` does not need this build: tsx runs the sources.
 */
import { cpSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_ENTRY = resolve(appRoot, '../agent/src/main.ts');
const AGENT_OUT_DIR = resolve(appRoot, 'out/agent');
const MIGRATIONS = resolve(appRoot, '../../packages/storage/drizzle');

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
/** Bundle relative imports and @ticket/* sources; keep every other bare import external. */
const external = (id) =>
  builtins.has(id) || (!id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:/.test(id) && !id.startsWith('@ticket/'));

rmSync(AGENT_OUT_DIR, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: 'warn',
  root: appRoot,
  mode: 'production',
  ssr: { noExternal: [/^@ticket\//], target: 'node' },
  build: {
    ssr: AGENT_ENTRY,
    outDir: AGENT_OUT_DIR,
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    minify: false,
    copyPublicDir: false,
    rollupOptions: {
      external,
      output: { format: 'es', entryFileNames: 'main.js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});
cpSync(MIGRATIONS, resolve(AGENT_OUT_DIR, 'drizzle'), { recursive: true });
console.info(`Agent built: ${AGENT_OUT_DIR}/main.js`);
