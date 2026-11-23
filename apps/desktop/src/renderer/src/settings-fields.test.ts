import { type SettingField } from '@ticket/shared';
import { describe, expect, it } from 'vitest';
import { fieldState, SETTINGS_CATEGORIES, SETTINGS_CATEGORY_LABELS } from './settings-fields.js';

describe('fieldState', () => {
  it('makes an OLLAMA_HOST override read-only and labels it with the variable name', () => {
    const field: SettingField<'ollamaBaseUrl'> = {
      value: 'http://ollama.internal:11434',
      source: 'env',
      saved: 'http://127.0.0.1:11434',
      envVar: 'OLLAMA_HOST',
      envError: null,
    };
    expect(fieldState(field)).toEqual({
      readOnly: true,
      sourceLabel: 'Overridden by OLLAMA_HOST',
      envError: null,
    });
  });

  it('keeps a field editable when the variable is invalid, and shows the error', () => {
    const field: SettingField<'ollamaBaseUrl'> = {
      value: 'http://127.0.0.1:11434',
      source: 'default',
      saved: null,
      envVar: 'OLLAMA_HOST',
      envError: 'OLLAMA_HOST is set but not applied: Use http or https.',
    };
    const state = fieldState(field);
    expect(state.readOnly).toBe(false);
    expect(state.sourceLabel).toBe('Default');
    expect(state.envError).toMatch(/OLLAMA_HOST/);
  });

  it('shows only the four categories', () => {
    expect(SETTINGS_CATEGORIES.map((c) => SETTINGS_CATEGORY_LABELS[c])).toEqual([
      'Ollama Connection',
      'AI Models',
      'Classification',
      'Storage',
    ]);
  });
});
