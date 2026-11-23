import { AgentStateFileSchema, type AgentStateFile } from '@ticket/agent-protocol';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tokensEqual } from './token.js';

export const STATE_FILE_NAME = 'agent-state.json';

/** `apps/agent/.agent-data/agent-state.json` (gitignored). */
export const DEFAULT_STATE_FILE = resolve(
  import.meta.dirname,
  '..',
  '.agent-data',
  STATE_FILE_NAME,
);

/** AGENT_STATE_FILE overrides the default path. */
export function resolveStateFilePath(env: NodeJS.ProcessEnv): string {
  const override = env['AGENT_STATE_FILE']?.trim();
  return override ? resolve(override) : DEFAULT_STATE_FILE;
}

/**
 * Writes the state atomically (temp file + rename) so a reader never sees a partial
 * file. The schema pins `host` to 127.0.0.1. POSIX: mode 0600 in a 0700 folder.
 * Windows ignores the mode; the file relies on the per-user ACL of its folder.
 */
export function writeStateFile(path: string, state: AgentStateFile): void {
  const json = JSON.stringify(AgentStateFileSchema.parse(state), null, 2);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, json, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

/** Removes the file only if it still holds `token`, i.e. a newer agent has not replaced it. */
export function removeStateFile(path: string, token: string): boolean {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const parsed = AgentStateFileSchema.safeParse(current);
  if (!parsed.success || !tokensEqual(parsed.data.token, token)) return false;
  rmSync(path, { force: true });
  return true;
}
