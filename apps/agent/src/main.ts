import pkg from '../package.json' with { type: 'json' };
import { resolveStateFilePath, runAgent } from './index.js';

async function main(): Promise<void> {
  const log = (message: string) => console.info(`[agent] ${message}`);
  const agent = await runAgent({
    stateFile: resolveStateFilePath(process.env),
    agentVersion: pkg.version,
    log,
  });
  log(`Listening on ${agent.server.host}:${agent.server.port} (pid ${process.pid}).`);
  log(`State file: ${agent.stateFile}`);

  const shutdown = (signal: string) => {
    log(`${signal}: shutting down.`);
    void agent.stop().then(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(signal, () => shutdown(signal));
  }
}

main().catch((error: unknown) => {
  console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
