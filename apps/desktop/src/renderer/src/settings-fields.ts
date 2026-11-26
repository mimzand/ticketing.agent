import { type SettingField, type SettingKey, type SettingSource } from '@ticket/shared';

/** How Settings presents one field: editable, or read-only because a variable overrides it. */
export interface FieldState {
  readonly readOnly: boolean;
  /** "Overridden by OLLAMA_HOST", "Saved", or "Default". */
  readonly sourceLabel: string;
  /** Set when the variable is present but invalid (so not applied). */
  readonly envError: string | null;
}

const SOURCE_LABELS: Record<SettingSource, string> = {
  default: 'Default',
  saved: 'Saved',
  env: 'Overridden',
};

export function fieldState<K extends SettingKey>(field: SettingField<K>): FieldState {
  const overridden = field.source === 'env' && field.envVar !== null;
  return {
    readOnly: overridden,
    sourceLabel: overridden ? `Overridden by ${field.envVar}` : SOURCE_LABELS[field.source],
    envError: field.envError,
  };
}

export const SETTINGS_CATEGORIES = ['ollama', 'models', 'classification', 'storage'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  ollama: 'Ollama Connection',
  models: 'AI Models',
  classification: 'Classification',
  storage: 'Storage',
};

export const SETTINGS_CATEGORY_DESCRIPTIONS: Record<SettingsCategory, string> = {
  ollama: 'Server URL, connection timeout, test, and access token.',
  models: 'Models on the server, the active model, the optional fallback model, and the classify timeout.',
  classification: 'Minimum confidence for applying a label.',
  storage: 'Database path and row counts (read only).',
};

/**
 * The fallback model choices: the server's models (and the current value if the
 * server no longer lists it), never the primary model. "Disabled" is null.
 */
export function fallbackModelOptions(serverModels: readonly string[], primary: string, current: string | null): string[] {
  const names = serverModels.filter((name) => name !== primary);
  return current !== null && current !== primary && !names.includes(current) ? [current, ...names] : names;
}

/** Why the fallback cannot be saved, or null. The host refuses the same pair too. */
export function fallbackModelProblem(primary: string, fallback: string | null): string | null {
  return fallback !== null && fallback === primary ? 'The fallback model must differ from the primary model.' : null;
}
