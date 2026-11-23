import { resolve } from 'node:path';

/**
 * AGENT_STATE_FILE, or the agent's default (`apps/agent/.agent-data/agent-state.json`)
 * found next to this app's folder. In v1 the desktop connects to an agent that
 * is already running; it never spawns one.
 */
export function resolveAgentStateFile(env: NodeJS.ProcessEnv, appPath: string): string {
  const override = env['AGENT_STATE_FILE']?.trim();
  if (override) return resolve(override);
  return resolve(appPath, '..', 'agent', '.agent-data', 'agent-state.json');
}
