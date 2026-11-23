import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseSuiteFile, type SuiteFile } from './suite.js';

/** The checked-in suite, versioned next to the code. */
export const GOLDEN_DIR = join(import.meta.dirname, '..', 'golden');

/** Every `*.json` in the golden folder, sorted by name. */
export function goldenSuitePaths(dir = GOLDEN_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

/** Reads and validates one suite file. Errors name the file, not its folder. */
export function loadSuiteFile(path: string): SuiteFile {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${name} could not be read as JSON.`);
  }
  return parseSuiteFile(name, raw);
}
