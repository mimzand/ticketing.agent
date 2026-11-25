import { type CaseResult, type CatalogueInfo, type SuiteRun } from './run.js';

export interface DepartmentMetrics {
  readonly departmentId: string;
  /** Applied this department and expected it. */
  readonly truePositives: number;
  /** Applied this department, expected another (or none). */
  readonly falsePositives: number;
  /** Expected this department, applied another (or none). */
  readonly falseNegatives: number;
  /** null when the department was never applied. */
  readonly precision: number | null;
  /** null when no case expects the department. */
  readonly recall: number | null;
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly bySource: Readonly<Record<'golden' | 'override', { readonly total: number; readonly passed: number }>>;
  /** Cases whose applied department (or none) equals the expected one. */
  readonly labelMatches: number;
  /** labelMatches / cases that produced an outcome; null when none did. */
  readonly accuracy: number | null;
  readonly departments: readonly DepartmentMetrics[];
  /** Cases where exactly one of expected/actual is `needs_review`. */
  readonly needsReviewMismatches: number;
  /** Cases where exactly one of expected/actual is `failed`. */
  readonly failedMismatches: number;
  /** Cases that did not run to a decision. */
  readonly errors: number;
  readonly catalogues: readonly CatalogueInfo[];
  readonly failures: readonly CaseResult[];
  /** Scored apart from the department, over cases that set the expectation. */
  readonly category: FieldScore;
  readonly priority: FieldScore;
}

export interface FieldScore {
  /** Cases that set this expectation and produced a decision. */
  readonly scored: number;
  readonly matches: number;
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/** Pure: metrics over the results of one or more suite runs. */
export function buildReport(runs: readonly SuiteRun[]): EvalReport {
  const results = runs.flatMap((run) => run.results);
  const scored = results.flatMap((r) => (r.actual ? [{ expected: r.expected, actual: r.actual }] : []));

  const ids = new Set<string>();
  for (const { expected, actual } of scored) {
    if (expected.departmentId) ids.add(expected.departmentId);
    if (actual.departmentId) ids.add(actual.departmentId);
  }
  const departments = [...ids].sort().map((departmentId) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const { expected, actual } of scored) {
      const expects = expected.departmentId === departmentId;
      const applied = actual.departmentId === departmentId;
      if (expects && applied) truePositives += 1;
      else if (applied) falsePositives += 1;
      else if (expects) falseNegatives += 1;
    }
    return {
      departmentId,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(truePositives, truePositives + falseNegatives),
    };
  });

  const mismatches = (status: string) =>
    scored.filter(({ expected, actual }) => (expected.status === status) !== (actual.status === status)).length;
  const source = (name: 'golden' | 'override') => {
    const of = results.filter((r) => r.source === name);
    return { total: of.length, passed: of.filter((r) => r.passed).length };
  };
  const fieldScore = (field: 'categoryId' | 'priority'): FieldScore => {
    const set = scored.filter(({ expected }) => expected[field] !== undefined);
    return { scored: set.length, matches: set.filter(({ expected, actual }) => expected[field] === actual[field]).length };
  };
  const labelMatches = scored.filter(({ expected, actual }) => expected.departmentId === actual.departmentId).length;
  const passed = results.filter((r) => r.passed).length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    bySource: { golden: source('golden'), override: source('override') },
    labelMatches,
    accuracy: ratio(labelMatches, scored.length),
    departments,
    needsReviewMismatches: mismatches('needs_review'),
    failedMismatches: mismatches('failed'),
    errors: results.length - scored.length,
    catalogues: runs.flatMap((run) => run.catalogues),
    failures: results.filter((r) => !r.passed),
    category: fieldScore('categoryId'),
    priority: fieldScore('priority'),
  };
}

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

/**
 * A short plain-text summary. Case ids, department ids, counts, and catalogue hashes
 * only: no ticket text, no address, no path, no token.
 */
export function formatReport(report: EvalReport): string {
  const lines = [
    `Golden eval: ${report.total} cases (${report.bySource.golden.total} golden, ${report.bySource.override.total} override): ` +
      `${report.passed} passed, ${report.failed} failed`,
    `Accuracy: ${percent(report.accuracy)} (${report.labelMatches}/${report.total - report.errors} applied labels match)`,
    `Mismatches: needs_review ${report.needsReviewMismatches} · failed ${report.failedMismatches} · run errors ${report.errors}`,
  ];
  if (report.departments.length > 0) {
    const width = Math.max(10, ...report.departments.map((d) => d.departmentId.length));
    lines.push(`${'department'.padEnd(width)}  precision  recall  tp/fp/fn`);
    for (const d of report.departments) {
      lines.push(
        `${d.departmentId.padEnd(width)}  ${percent(d.precision).padStart(9)}  ${percent(d.recall).padStart(6)}  ` +
          `${d.truePositives}/${d.falsePositives}/${d.falseNegatives}`,
      );
    }
  }
  // Category and priority are scored apart: they never change the department lines above.
  for (const [label, score] of [
    ['Category', report.category],
    ['Priority', report.priority],
  ] as const) {
    if (score.scored > 0) {
      lines.push(`${label}: ${percent(score.matches / score.scored)} (${score.matches}/${score.scored} cases that set it)`);
    }
  }
  for (const c of report.catalogues) {
    lines.push(`Catalogue ${c.suite}/${c.name}: taxonomy v${c.taxonomyVersion ?? '?'} · sha256 ${c.hash}`);
  }
  for (const f of report.failures) lines.push(`FAIL ${f.suite}/${f.id}: ${f.problems.join('; ')}`);
  return lines.join('\n');
}
