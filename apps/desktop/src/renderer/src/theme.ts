/**
 * Dark/light theme: a shell preference kept in the renderer's localStorage. Not a
 * ticket-database row and not an agent setting. `public/theme-boot.js` applies the
 * saved choice before the first paint; index.html already starts as dark.
 */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'dark';
export const THEME_STORAGE_KEY = 'ticket.theme';

/** The parts of `localStorage` and `document.documentElement` this module touches. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export const isTheme = (value: unknown): value is Theme =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value);

/** The saved theme, or dark. Storage can be unavailable; then the default applies. */
export function readTheme(storage: ThemeStorage | undefined): Theme {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.setAttribute('data-theme', theme);
}

/** Applies the theme now and remembers it across restarts. */
export function setTheme(theme: Theme, target: { storage: ThemeStorage | undefined; root: ThemeRoot }): void {
  applyTheme(target.root, theme);
  try {
    target.storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not remembered, but applied for this session.
  }
}

/** `localStorage`, or undefined where the browser refuses it. */
export function browserStorage(): ThemeStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
