import { describe, expect, it } from 'vitest';
import { buildReport, formatReport } from './metrics.js';
import { type CaseResult, type Outcome, type SuiteRun } from './run.js';
import { type Expectation } from './suite.js';

const outcome = (status: Outcome['status'], departmentId: string | null, extra: Partial<Outcome> = {}): Outcome => ({
  status,
  departmentId,
  confidence: 0.9,
  quote: null,
  taxonomyVersion: 2,
  categoryId: null,
  priority: null,
  ...extra,
});
const expectation = (status: Expectation['status'], departmentId: string | null): Expectation => ({ status, departmentId });

function result(id: string, expected: Expectation, actual: Outcome | null, source: CaseResult['source'] = 'golden'): CaseResult {
  const passed = actual !== null && actual.status === expected.status && actual.departmentId === expected.departmentId;
  return { suite: 's', id, source, catalogue: 'c', expected, actual, passed, problems: passed ? [] : ['mismatch'] };
}

const run = (results: CaseResult[]): SuiteRun => ({
  suite: 's',
  threshold: 0.7,
  results,
  catalogues: [{ suite: 's', name: 'c', hash: 'abc123abc123', taxonomyVersion: 2 }],
});

describe('buildReport', () => {
  it('computes accuracy, per-department precision and recall, and status mismatches', () => {
    const report = buildReport([
      run([
        result('a', expectation('labeled', 'billing'), outcome('labeled', 'billing')),
        result('b', expectation('labeled', 'billing'), outcome('labeled', 'it')),
        result('c', expectation('labeled', 'it'), outcome('needs_review', null), 'override'),
        result('d', expectation('needs_review', null), outcome('labeled', 'billing')),
        result('e', expectation('failed', null), outcome('failed', null)),
        result('f', expectation('failed', null), null),
      ]),
    ]);
    expect(report).toMatchObject({
      total: 6,
      passed: 2,
      failed: 4,
      bySource: { golden: { total: 5, passed: 2 }, override: { total: 1, passed: 0 } },
      labelMatches: 2,
      accuracy: 2 / 5,
      needsReviewMismatches: 2,
      failedMismatches: 0,
      errors: 1,
    });
    expect(report.departments).toEqual([
      { departmentId: 'billing', truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5 },
      { departmentId: 'it', truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0 },
    ]);
    expect(report.failures.map((f) => f.id)).toEqual(['b', 'c', 'd', 'f']);
  });

  it('reports null precision for a department that was never applied', () => {
    const report = buildReport([run([result('a', expectation('labeled', 'hr'), outcome('needs_review', null))])]);
    expect(report.departments).toEqual([
      { departmentId: 'hr', truePositives: 0, falsePositives: 0, falseNegatives: 1, precision: null, recall: 0 },
    ]);
  });

  it('formats a short summary with ids, counts, and the catalogue version only', () => {
    const text = formatReport(
      buildReport([
        run([
          result('ok', expectation('labeled', 'billing'), outcome('labeled', 'billing')),
          result('bad', expectation('labeled', 'billing'), outcome('needs_review', null)),
        ]),
      ]),
    );
    expect(text).toContain('2 cases (2 golden, 0 override): 1 passed, 1 failed');
    expect(text).toContain('Accuracy: 50.0% (1/2 applied labels match)');
    expect(text).toContain('Catalogue s/c: taxonomy v2 · sha256 abc123abc123');
    expect(text).toContain('FAIL s/bad: mismatch');
    expect(text).toMatch(/billing\s+100\.0%\s+50\.0%\s+1\/0\/1/);
  });

  it('scores category and priority apart, only where a case sets them; a priority miss leaves the department lines alone', () => {
    const departmentOnly = buildReport([
      run([
        result('a', expectation('labeled', 'billing'), outcome('labeled', 'billing', { priority: 'low' })),
        result('b', expectation('labeled', 'billing'), outcome('labeled', 'billing')),
      ]),
    ]);
    expect(departmentOnly.category).toEqual({ scored: 0, matches: 0 });
    expect(departmentOnly.priority).toEqual({ scored: 0, matches: 0 });
    expect(formatReport(departmentOnly)).not.toMatch(/^(Category|Priority):/m);

    const withFields = buildReport([
      run([
        result('a', { ...expectation('labeled', 'billing'), priority: 'urgent', categoryId: 'outage' }, outcome('labeled', 'billing', { priority: 'low', categoryId: 'outage' })),
        result('b', { ...expectation('labeled', 'billing'), categoryId: null }, outcome('labeled', 'billing')),
      ]),
    ]);
    expect(withFields.category).toEqual({ scored: 2, matches: 2 });
    expect(withFields.priority).toEqual({ scored: 1, matches: 0 });
    expect(withFields.departments).toEqual(departmentOnly.departments);
    expect(withFields.accuracy).toBe(departmentOnly.accuracy);
    const text = formatReport(withFields);
    expect(text).toContain('Category: 100.0% (2/2 cases that set it)');
    expect(text).toContain('Priority: 0.0% (0/1 cases that set it)');
    expect(text).toMatch(/billing\s+100\.0%\s+100\.0%\s+2\/0\/0/);
  });
});
