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
  models: 'Models on the server, the active model, and the classify timeout.',
  classification: 'Minimum confidence for applying a label.',
  storage: 'Database path and row counts (read only).',
};
