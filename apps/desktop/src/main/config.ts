import { join, resolve } from 'node:path';

/**
 * AGENT_STATE_FILE, or the same default `yarn agent:dev` uses
 * (`apps/agent/.agent-data/agent-state.json`), so the desktop attaches to an agent
 * that is already running and otherwise starts one at the same place. A packaged app
 * keeps it in its user data folder.
 */
export function resolveAgentStateFile(
  env: NodeJS.ProcessEnv,
  appPath: string,
  packaged?: { readonly userData: string },
): string {
  const override = env['AGENT_STATE_FILE']?.trim();
  if (override) return resolve(override);
  if (packaged) return join(packaged.userData, 'agent', 'agent-state.json');
  return resolve(appPath, '..', 'agent', '.agent-data', 'agent-state.json');
}

/** TICKET_DATA_DIR, or the agent's own default (`apps/agent/.data/tickets.db`). */
export function resolveTicketDatabase(
  env: NodeJS.ProcessEnv,
  appPath: string,
  packaged?: { readonly userData: string },
): string {
  const override = env['TICKET_DATA_DIR']?.trim();
  if (override) return resolve(override);
  if (packaged) return join(packaged.userData, 'data', 'tickets.db');
  return resolve(appPath, '..', 'agent', '.data', 'tickets.db');
}
