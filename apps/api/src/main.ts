import { serve } from '@hono/node-server';
import { createAgentLink } from '@ticket/agent-client';
import pkg from '../package.json' with { type: 'json' };
import { createApiApp, readApiConfig } from './index.js';

const log = (message: string) => console.info(`[api] ${message}`);
const config = readApiConfig(process.env);
if (config.apiKeyGenerated) {
  log(`API_KEY is unset. Generated a key for this process: ${config.apiKey}`);
}

// One lazy connection: `yarn api:up` may start the API before the agent is listening.
const agent = createAgentLink({
  stateFile: config.agentStateFile,
  client: { kind: 'cli', version: pkg.version },
  log,
});

const server = serve(
  { fetch: createApiApp({ agent, apiKey: config.apiKey, corsOrigins: config.corsOrigins, log }).fetch, hostname: config.host, port: config.port },
  (info) => {
    log(`Listening on http://${config.host}:${info.port}`);
    log(`Agent state file: ${config.agentStateFile}`);
    log(
      config.corsOrigins.length > 0
        ? `CORS allowed for: ${config.corsOrigins.join(', ')}`
        : 'CORS: no browser origin is allowed (CORS_ORIGINS is empty).',
    );
  },
);
server.once('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `[api] ${config.host}:${config.port} is already in use. Set API_PORT to another port.`
      : `[api] ${error.message}`,
  );
  agent.close();
  process.exit(1);
});

const shutdown = (signal: string) => {
  log(`${signal}: shutting down.`);
  agent.close();
  server.close(() => process.exit(0));
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.once(signal, () => shutdown(signal));
}
