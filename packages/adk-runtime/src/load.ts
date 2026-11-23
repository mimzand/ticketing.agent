import { sanitizeAdkEnvironment } from './env.js';

/** Sanitises `env`, then imports the ADK facade. The import itself is the load. */
export async function loadAdkRuntime(env: NodeJS.ProcessEnv = process.env) {
  sanitizeAdkEnvironment(env);
  return import('./adk.js');
}
