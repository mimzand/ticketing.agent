import { AgentClientError, type AgentLink } from '@ticket/agent-client';
import { DesktopHealthSchema, type DesktopHealth } from '@ticket/shared';

export const HEALTH_PING_TIMEOUT_MS = 2_000;

/** Pings the agent and returns what the renderer may see: no token, no port. */
export async function readAgentHealth(
  agent: Pick<AgentLink, 'ping'>,
  now: () => Date = () => new Date(),
): Promise<DesktopHealth> {
  try {
    const ping = await agent.ping({ timeoutMs: HEALTH_PING_TIMEOUT_MS });
    return DesktopHealthSchema.parse({
      agent: 'connected',
      ping,
      checkedAt: now().toISOString(),
    });
  } catch (error) {
    return DesktopHealthSchema.parse({
      agent: 'unavailable',
      reason: describe(error),
      checkedAt: now().toISOString(),
    });
  }
}

/** Fixed text per failure. AgentClientError messages never contain the token. */
function describe(error: unknown): string {
  if (!(error instanceof AgentClientError)) return 'The agent did not answer.';
  switch (error.code) {
    case 'not_running':
      return 'The agent is not running. Start it with `yarn agent:dev`.';
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
