import { describe, expect, it } from 'vitest';
import { applyTheme, DEFAULT_THEME, readTheme, setTheme, THEME_STORAGE_KEY, type ThemeStorage } from './theme.js';

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function fakeRoot() {
  const attributes: Record<string, string> = {};
  return { attributes, setAttribute: (name: string, value: string) => void (attributes[name] = value) };
}

describe('theme', () => {
  it('is dark by default', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readTheme(memoryStorage())).toBe('dark');
    expect(readTheme(undefined)).toBe('dark');
    expect(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'purple' }))).toBe('dark');
    const root = fakeRoot();
    applyTheme(root, readTheme(memoryStorage()));
    expect(root.attributes['data-theme']).toBe('dark');
  });

  it('switching to light sets the theme attribute and is remembered', () => {
    const storage = memoryStorage();
    const root = fakeRoot();
    setTheme('light', { storage, root });
    expect(root.attributes['data-theme']).toBe('light');
    expect(storage.data[THEME_STORAGE_KEY]).toBe('light');
    // Next start reads the remembered choice.
    expect(readTheme(storage)).toBe('light');
  });

  it('survives storage that throws', () => {
    const broken: ThemeStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const root = fakeRoot();
    expect(readTheme(broken)).toBe('dark');
    setTheme('light', { storage: broken, root });
    expect(root.attributes['data-theme']).toBe('light');
  });
});
