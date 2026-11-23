import { z } from 'zod';
import { CLASSIFY_MIN_CONFIDENCE_DEFAULT } from './ticket.js';

// WHATWG URL exists in Node, Electron, and browsers. Declared here because this
// package compiles without DOM or Node typings.
declare const URL: new (input: string) => {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
  toString(): string;
};

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen3:8b';
export const OLLAMA_CONNECT_TIMEOUT_DEFAULT_MS = 5_000;
export const CLASSIFY_TIMEOUT_DEFAULT_MS = 120_000;
/** Extra wait so the client outlives the model's own budget and can hear its answer. */
export const CLASSIFY_REQUEST_MARGIN_MS = 15_000;

/** How long a caller waits for `tickets.classify`. Longer than the model timeout. */
export function classifyRequestTimeoutMs(classifyTimeoutMs: number): number {
  return classifyTimeoutMs + CLASSIFY_REQUEST_MARGIN_MS;
}

/** Why a server URL is refused. Never echoes the URL (it may hold credentials). */
export function ollamaUrlProblem(raw: string): string | null {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter an http:// or https:// URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use http or https.';
  if (url.username || url.password) return 'Do not put a user name or password in the URL.';
  if (url.search || url.hash) return 'Remove the query (?) or fragment (#) from the URL.';
  return null;
}

/** http(s) only, no credentials, query, or fragment. Normalised without a trailing slash. */
export const OllamaBaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter the server URL.')
  .max(2_048)
  .superRefine((value, ctx) => {
    const problem = ollamaUrlProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .transform((value) => new URL(value).toString().replace(/\/$/, ''));

export const OllamaModelNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/, 'Enter an Ollama model name, e.g. qwen3:8b.');

export const ConnectTimeoutMsSchema = z
  .number()
  .int('Use whole milliseconds.')
  .min(500, 'At least 500 ms.')
  .max(600_000, 'At most 600,000 ms.');

export const ClassifyTimeoutMsSchema = z
  .number()
  .int('Use whole milliseconds.')
  .min(1_000, 'At least 1,000 ms.')
  .max(3_600_000, 'At most 3,600,000 ms.');

export const MinConfidenceSchema = z
  .number()
  .min(0, 'Use a number from 0 to 1.')
  .max(1, 'Use a number from 0 to 1.');

/** Every non-secret setting. Stored by the agent in SQLite; the access token never is. */
export const SettingsValuesSchema = z.strictObject({
  ollamaBaseUrl: OllamaBaseUrlSchema,
  connectTimeoutMs: ConnectTimeoutMsSchema,
  model: OllamaModelNameSchema,
  classifyTimeoutMs: ClassifyTimeoutMsSchema,
  minConfidence: MinConfidenceSchema,
});
export type SettingsValues = z.infer<typeof SettingsValuesSchema>;
export type SettingKey = keyof SettingsValues;
export const SETTING_KEYS = [
  'ollamaBaseUrl',
  'connectTimeoutMs',
  'model',
  'classifyTimeoutMs',
  'minConfidence',
] as const satisfies readonly SettingKey[];

export const SETTINGS_DEFAULTS: SettingsValues = {
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  connectTimeoutMs: OLLAMA_CONNECT_TIMEOUT_DEFAULT_MS,
  model: OLLAMA_DEFAULT_MODEL,
  classifyTimeoutMs: CLASSIFY_TIMEOUT_DEFAULT_MS,
  minConfidence: CLASSIFY_MIN_CONFIDENCE_DEFAULT,
};

/** A save: any subset of the settings, all validated. Unknown keys are refused. */
export const SettingsPatchSchema = SettingsValuesSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  'Change at least one setting.',
);
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** The three settings an environment variable may override. */
export const SETTING_ENV_VARS = {
  ollamaBaseUrl: 'OLLAMA_HOST',
  model: 'OLLAMA_MODEL',
  minConfidence: 'CLASSIFY_MIN_CONFIDENCE',
} as const satisfies Partial<Record<SettingKey, string>>;
export type SettingEnvVar = (typeof SETTING_ENV_VARS)[keyof typeof SETTING_ENV_VARS];

export const SettingSourceSchema = z.enum(['default', 'saved', 'env']);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

const fieldOf = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    /** The value the next classify uses. */
    value,
    source: SettingSourceSchema,
    /** The saved value, also when an environment variable overrides it. */
    saved: value.nullable(),
    /** Set when an environment variable may override this setting. */
    envVar: z.enum(['OLLAMA_HOST', 'OLLAMA_MODEL', 'CLASSIFY_MIN_CONFIDENCE']).nullable(),
    /** The variable is set but invalid, so it is not applied. Never echoes the value. */
    envError: z.string().max(300).nullable(),
  });

export const SettingsViewSchema = z.strictObject({
  fields: z.strictObject({
    ollamaBaseUrl: fieldOf(z.string().max(2_048)),
    connectTimeoutMs: fieldOf(z.number()),
    model: fieldOf(z.string().max(128)),
    classifyTimeoutMs: fieldOf(z.number()),
    minConfidence: fieldOf(z.number()),
  }),
  /** Whether the agent holds an Ollama access token. Never the token itself. */
  tokenSet: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;
export type SettingField<K extends SettingKey> = SettingsView['fields'][K];

/** What the renderer gets: the agent's view plus whether this machine can encrypt a token. */
export const DesktopSettingsViewSchema = SettingsViewSchema.extend({
  tokenEncryptionAvailable: z.boolean(),
}).strict();
export type DesktopSettingsView = z.infer<typeof DesktopSettingsViewSchema>;

/** Access token: one line, no whitespace. Travels renderer → main → agent only. */
export const OllamaTokenSchema = z
  .string()
  .trim()
  .min(1, 'Enter the token.')
  .max(4_096)
  .regex(/^\S+$/, 'A token has no spaces.');

/** Agent protocol only (shell → agent). `null` clears the token. */
export const SetOllamaTokenSchema = z.strictObject({ token: OllamaTokenSchema.nullable() });
export const TokenStateSchema = z.strictObject({ tokenSet: z.boolean() });
export type TokenState = z.infer<typeof TokenStateSchema>;

/** Test connection: the URL from the form, not saved. */
export const ConnectionTestRequestSchema = z.strictObject({
  baseUrl: OllamaBaseUrlSchema,
  timeoutMs: ConnectTimeoutMsSchema.optional(),
});
export type ConnectionTestRequest = z.input<typeof ConnectionTestRequestSchema>;

export const ConnectionTestResultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string().max(500),
  modelCount: z.int().min(0).nullable(),
  /** Whether the access token was sent (https or loopback only). */
  tokenSent: z.boolean(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const ModelListSchema = z.strictObject({
  reachable: z.boolean(),
  server: z.string().max(2_048),
  models: z.array(z.strictObject({ name: z.string().min(1).max(256), size: z.number().nullable() })).max(500),
  message: z.string().max(500),
});
export type ModelList = z.infer<typeof ModelListSchema>;

export const StorageInfoSchema = z.strictObject({
  databasePath: z.string().max(4_096),
  departmentCount: z.int().min(0),
  ticketCount: z.int().min(0),
});
export type StorageInfo = z.infer<typeof StorageInfoSchema>;
