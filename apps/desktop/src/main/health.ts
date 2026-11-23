import { AgentClientError, type AgentLink } from '@ticket/agent-client';
import { DesktopHealthSchema, type DesktopHealth } from '@ticket/shared';
import { type SupervisorStatus } from './agent-supervisor.js';

export const HEALTH_PING_TIMEOUT_MS = 2_000;

/** Pings the agent and returns what the renderer may see: no token, no port. */
export async function readAgentHealth(
  agent: Pick<AgentLink, 'ping'>,
  now: () => Date = () => new Date(),
  supervisor?: { status(): SupervisorStatus },
): Promise<DesktopHealth> {
  // While the app's own agent is being restarted, say so at once instead of waiting.
  const before = supervisor?.status();
  if (before?.reconnecting) {
    return DesktopHealthSchema.parse({
      agent: 'unavailable',
      reason: 'The agent stopped unexpectedly. Reconnecting…',
      reconnecting: true,
      checkedAt: now().toISOString(),
    });
  }
  try {
    const ping = await agent.ping({ timeoutMs: HEALTH_PING_TIMEOUT_MS });
    return DesktopHealthSchema.parse({
      agent: 'connected',
      ping,
      mode: supervisor?.status().mode ?? null,
      checkedAt: now().toISOString(),
    });
  } catch (error) {
    const reconnecting = supervisor?.status().reconnecting ?? false;
    return DesktopHealthSchema.parse({
      agent: 'unavailable',
      reason: reconnecting ? 'The agent stopped unexpectedly. Reconnecting…' : describe(error, supervisor !== undefined),
      reconnecting,
      checkedAt: now().toISOString(),
    });
  }
}

/** Fixed text per failure. AgentClientError messages never contain the token. */
function describe(error: unknown, supervised: boolean): string {
  if (!(error instanceof AgentClientError)) {
    return error instanceof Error && supervised ? error.message.slice(0, 300) : 'The agent did not answer.';
  }
  switch (error.code) {
    case 'not_running':
      return supervised ? 'The agent is not running.' : 'The agent is not running. Start it with `yarn agent:dev`.';
    case 'state_file_invalid':
      return 'The agent state file is not valid.';
    case 'unauthorized':
      return 'The agent refused the connection (token mismatch).';
    case 'timeout':
      return 'The agent did not answer in time.';
    default:
      return 'The agent is not reachable.';
  }
}
