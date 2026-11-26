import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = join(import.meta.dirname, '..');
const cli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], PROJECT_CWD: packageDir },
  });

describe('eval CLI', () => {
  it('exits 0 on the checked-in suite and 1 when an expectation is broken', () => {
    const ok = cli(['run']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/0 failed/);

    const dir = mkdtempSync(join(tmpdir(), 'ticket-eval-cli-'));
    try {
      const golden = JSON.parse(readFileSync(join(packageDir, 'golden', 'golden.json'), 'utf8')) as {
        suite: string;
        cases: { expect: { departmentId: string | null } }[];
      };
      const [first] = golden.cases;
      if (!first) throw new Error('fixture');
      first.expect.departmentId = first.expect.departmentId === 'it' ? 'billing' : 'it';
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, JSON.stringify({ ...golden, suite: 'broken', cases: [first] }));
      const bad = cli(['run', broken]);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/FAIL broken\//);
      // No path, no ticket text in the summary.
      expect(bad.stdout).not.toContain(dir);
      expect(bad.stdout).not.toContain('charged twice on my card');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes override cases and few-shot candidates from an export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-eval-cli-'));
    try {
      const result = cli(['feedback', 'fixtures/override-feedback.sample.json', '--out', dir]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Override cases: 2');
      expect(result.stdout).toContain('Few-shot candidates: 2');
      expect(JSON.parse(readFileSync(join(dir, 'override-cases.json'), 'utf8'))).toEqual(
        JSON.parse(readFileSync(join(packageDir, 'golden', 'overrides-sample.json'), 'utf8')),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('writes decision-feedback cases and category candidates from an export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-decision-feedback-cli-'));
    try {
      const result = cli(['decision-feedback', 'fixtures/decision-feedback.sample.json', '--out', dir]);
      expect(result.status, result.stderr).toBe(0);
      // The checked-in sample has 6 reviewed rows: 5 become cases (one inactive category is skipped)
      // and 3 become category few-shot candidates.
      expect(result.stdout).toContain('Reviewed decisions read: 6');
      expect(result.stdout).toContain('Feedback cases: 5');
      expect(result.stdout).toContain('Category few-shot candidates: 3');
      expect(JSON.parse(readFileSync(join(dir, 'decision-feedback-cases.json'), 'utf8'))).toEqual(
        JSON.parse(readFileSync(join(packageDir, 'golden', 'decision-feedback-sample.json'), 'utf8')),
      );
      expect(JSON.parse(readFileSync(join(dir, 'category-few-shot-candidates.json'), 'utf8'))).toEqual(
        JSON.parse(readFileSync(join(packageDir, 'fixtures', 'category-few-shot-candidates.sample.json'), 'utf8')),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
