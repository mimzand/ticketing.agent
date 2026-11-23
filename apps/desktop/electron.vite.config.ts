import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';
import { type Plugin } from 'vite';

const fromHere = (path: string): string => resolve(import.meta.dirname, path);

/**
 * CSP of the built renderer. Stricter than the one in index.html, which must let
 * the dev server inject styles and open its HMR socket. The renderer reaches main
 * only through the preload bridge, so it needs no network at all.
 */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const productionCsp = (): Plugin => ({
  name: 'ticket-production-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const pattern = /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;
    if (!pattern.test(html)) throw new Error('index.html has no Content-Security-Policy meta tag.');
    return html.replace(pattern, `$1${PRODUCTION_CSP}$2`);
  },
});

export default defineConfig({
  main: {
    build: {
      outDir: fromHere('out/main'),
      rollupOptions: { input: { index: fromHere('src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      outDir: fromHere('out/preload'),
      rollupOptions: {
        input: { index: fromHere('src/preload/index.ts') },
        // A sandboxed preload must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: fromHere('src/renderer'),
    plugins: [vue(), productionCsp()],
    // IPv4 loopback, not "localhost" (on Windows that may be ::1).
    server: { host: '127.0.0.1' },
    build: {
      sourcemap: false,
      outDir: fromHere('out/renderer'),
      rollupOptions: { input: { index: fromHere('src/renderer/index.html') } },
    },
  },
});
