import pkg from '../package.json' with { type: 'json' };
import { resolveStateFilePath, runAgent } from './index.js';

/** How often an agent started by the desktop checks that the app is still there. */
const PARENT_CHECK_MS = 1_000;

async function main(): Promise<void> {
  const log = (message: string) => console.info(`[agent] ${message}`);
  let stopping = false;
  const stopAndExit = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`${reason}: shutting down.`);
    void agent.stop().then(() => process.exit(0));
  };
  const agent = await runAgent({
    stateFile: resolveStateFilePath(process.env),
    agentVersion: pkg.version,
    log,
    // The desktop app that started this agent asks for a clean stop on quit.
    onShutdown: () => stopAndExit('system.shutdown'),
  });
  log(`Listening on ${agent.server.host}:${agent.server.port} (pid ${process.pid}).`);
  log(`State file: ${agent.stateFile}`);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(signal, () => stopAndExit(signal));
  }

  // Started by the desktop app: end with it, even if the app is killed outright.
  const parentPid = Number(process.env['TICKET_AGENT_PARENT_PID']);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EPERM') stopAndExit('The desktop app is gone');
      }
    }, PARENT_CHECK_MS).unref();
  }
}

main().catch((error: unknown) => {
  console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
