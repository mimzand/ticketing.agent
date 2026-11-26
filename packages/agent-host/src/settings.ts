import {
  MinConfidenceSchema,
  OllamaBaseUrlSchema,
  OllamaModelNameSchema,
  SETTING_ENV_VARS,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type SettingKey,
  type SettingsValues,
  type SettingsView,
} from '@ticket/shared';
import { type ZodType } from 'zod';

type EnvOverride = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

const ENV_PARSERS: Record<keyof typeof SETTING_ENV_VARS, (raw: string) => EnvOverride> = {
  ollamaBaseUrl: (raw) => parseWith(OllamaBaseUrlSchema, raw),
  model: (raw) => parseWith(OllamaModelNameSchema, raw),
  fallbackModel: (raw) => parseWith(OllamaModelNameSchema, raw),
  minConfidence: (raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: 'Use a number from 0 to 1.' };
    return parseWith(MinConfidenceSchema, value);
  },
};

function parseWith(schema: ZodType, raw: unknown): EnvOverride {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Issue messages only: the raw value is never echoed (a URL may hold credentials).
  return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid value.' };
}

const hasEnvVar = (key: SettingKey): key is keyof typeof SETTING_ENV_VARS => key in SETTING_ENV_VARS;

export interface ResolvedSettings {
  /** What the next classify uses. */
  readonly values: SettingsValues;
  readonly fields: SettingsView['fields'];
}

/**
 * Order, highest first: a set and valid environment variable (OLLAMA_HOST,
 * OLLAMA_MODEL, CLASSIFY_MIN_CONFIDENCE), the saved value, the default. An invalid
 * variable is not applied; its error is reported on the field.
 */
export function resolveSettings(saved: Partial<SettingsValues>, env: NodeJS.ProcessEnv): ResolvedSettings {
  const values: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const savedValue = saved[key];
    let value: unknown = savedValue ?? SETTINGS_DEFAULTS[key];
    let source: 'default' | 'saved' | 'env' = savedValue === undefined ? 'default' : 'saved';
    let envVar: string | null = null;
    let envError: string | null = null;
    if (hasEnvVar(key)) {
      envVar = SETTING_ENV_VARS[key];
      const raw = env[envVar]?.trim();
      if (raw) {
        const override = ENV_PARSERS[key](raw);
        if (override.ok) {
          value = override.value;
          source = 'env';
        } else {
          envError = `${envVar} is set but not applied: ${override.error}`;
        }
      }
    }
    values[key] = value;
    fields[key] = { value, source, saved: savedValue ?? null, envVar, envError };
  }
  return {
    values: values as unknown as SettingsValues,
    fields: fields as unknown as SettingsView['fields'],
  };
}

/** Keys an environment variable currently overrides. Saving them is refused. */
export function overriddenKeys(resolved: ResolvedSettings): SettingKey[] {
  return SETTING_KEYS.filter((key) => resolved.fields[key].source === 'env');
}
