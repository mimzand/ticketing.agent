/**
 * Names read by @google/adk before it would call a Google model or export traces.
 * The lists match the pattern source `packages/adk-runtime/src/env.ts`.
 */

export const TELEMETRY_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

export const CLOUD_ENV_VARS = [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

export const ADK_FEATURE_FLAG_PATTERN = /^ADK_(ENABLE|DISABLE)_[A-Z0-9_]+$/;

export const FORCED_ENV = Object.freeze({
  OTEL_SDK_DISABLED: 'true',
  ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
});

export interface EnvSanitizeReport {
  readonly removed: readonly string[];
  readonly forced: readonly string[];
}

/** Removes cloud and telemetry variables. Must run before `@google/adk` is imported. */
export function sanitizeAdkEnvironment(env: NodeJS.ProcessEnv): EnvSanitizeReport {
  const removed: string[] = [];
  const remove = (name: string) => {
    if (Object.hasOwn(env, name)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the name is from a fixed list or the flag pattern
      delete env[name];
      removed.push(name);
    }
  };
  for (const name of TELEMETRY_ENV_VARS) remove(name);
  for (const name of CLOUD_ENV_VARS) remove(name);
  for (const name of Object.keys(env)) {
    if (ADK_FEATURE_FLAG_PATTERN.test(name)) remove(name);
  }
  const forced: string[] = [];
  for (const [name, value] of Object.entries(FORCED_ENV)) {
    env[name] = value;
    forced.push(name);
  }
  return { removed, forced };
}
