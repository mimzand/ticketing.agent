import { describe, expect, it } from 'vitest';
import { goldenSuitePaths, loadSuiteFile } from './load.js';
import { buildReport } from './metrics.js';
import { runSuite } from './run.js';
import { parseSuiteFile, type SuiteFile, type SuiteFileInput } from './suite.js';

function suite(cases: SuiteFileInput['cases']): SuiteFile {
  return parseSuiteFile('t.json', {
    formatVersion: 1,
    suite: 't',
    catalogues: {
      main: [
        { id: 'billing', name: 'Billing', description: 'Invoices' },
        { id: 'it', name: 'IT', description: 'Computers' },
      ],
    },
    cases,
  });
}

const ticket = { externalId: 'r-1', subject: 'Invoice 7 is wrong', body: 'Please fix invoice 7.', channel: 'email' };
const billing = { kind: 'scripted', output: { departmentId: 'billing', confidence: 0.9, rationale: 'Invoice.', quote: 'Invoice 7' } } as const;

describe('runSuite through createAgentHost', () => {
  it('passes every checked-in case', async () => {
    const runs = [];
    for (const path of goldenSuitePaths()) runs.push(await runSuite(loadSuiteFile(path)));
    const report = buildReport(runs);
    expect(report.failures.map((f) => `${f.id}: ${f.problems.join('; ')}`)).toEqual([]);
    expect(report.total).toBeGreaterThanOrEqual(15);
    expect(report.bySource.override.total).toBeGreaterThan(0);
    // Every catalogue reports the taxonomy version the host stored.
    for (const catalogue of report.catalogues) expect(catalogue.taxonomyVersion).toBeGreaterThan(0);
  }, 60_000);

  it('fails a broken expectation and says why', async () => {
    const run = await runSuite(
      suite([{ id: 'x', source: 'golden', catalogue: 'main', ticket, reply: billing, expect: { status: 'labeled', departmentId: 'it' } }]),
    );
    expect(run.results[0]).toMatchObject({
      passed: false,
      actual: { status: 'labeled', departmentId: 'billing', quote: 'Invoice 7', taxonomyVersion: 2 },
      problems: ['department billing, expected it'],
    });
  });

  it('checks the confidence band and the quote', async () => {
    const run = await runSuite(
      suite([
        {
          id: 'x',
          source: 'golden',
          catalogue: 'main',
          ticket,
          reply: billing,
          expect: { status: 'labeled', departmentId: 'billing', confidence: 'below', quote: null },
        },
      ]),
    );
    expect(run.results[0]?.problems).toEqual(['confidence 0.9 is above 0.7, expected below', 'quote differs from expected']);
  });

  it('fails a case whose wrongReply would also pass', async () => {
    const run = await runSuite(
      suite([
        {
          id: 'x',
          source: 'golden',
          catalogue: 'main',
          ticket,
          reply: billing,
          wrongReply: billing,
          expect: { status: 'labeled', departmentId: 'billing' },
        },
      ]),
    );
    expect(run.results[0]?.passed).toBe(false);
    expect(run.results[0]?.problems[0]).toMatch(/wrongReply also meets/);
  });

  it('notices when the host calls the model fewer times than scripted', async () => {
    // The history ticket repeats the same externalId, so the second classify is not sent to the model.
    const email = 'sam.sample@example.com';
    const run = await runSuite(
      suite([
        {
          id: 'x',
          source: 'golden',
          catalogue: 'main',
          history: [{ ticket: { ...ticket, email }, reply: billing }],
          ticket: { ...ticket, email },
          reply: billing,
          expect: { status: 'labeled', departmentId: 'billing' },
        },
      ]),
    );
    expect(run.results[0]?.problems).toEqual(['the model was called 1 time(s) fewer than scripted']);
  });
});
