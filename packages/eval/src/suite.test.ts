import { describe, expect, it } from 'vitest';
import { goldenSuitePaths, loadSuiteFile } from './load.js';
import { parseSuiteFile, type SuiteFileInput } from './suite.js';

const base = (): SuiteFileInput => ({
  formatVersion: 1,
  suite: 't',
  catalogues: {
    main: [
      { id: 'billing', name: 'Billing', description: '' },
      { id: 'old', name: 'Old', description: '', active: false },
    ],
  },
  cases: [
    {
      id: 'one',
      source: 'golden',
      catalogue: 'main',
      ticket: { externalId: 'x-1', subject: 'Invoice', body: '', channel: 'email' },
      reply: { kind: 'scripted', output: { departmentId: 'billing', confidence: 0.9, rationale: 'r' } },
      expect: { status: 'labeled', departmentId: 'billing' },
    },
  ],
});

function withCase(patch: Record<string, unknown>): SuiteFileInput {
  const file = base();
  return { ...file, cases: [{ ...file.cases[0], ...patch } as SuiteFileInput['cases'][number]] };
}

describe('suite files', () => {
  it('every checked-in file is valid and has synthetic addresses only', () => {
    const paths = goldenSuitePaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const file = loadSuiteFile(path);
      for (const c of file.cases) {
        for (const email of [c.ticket.email, ...c.history.map((h) => h.ticket.email)]) {
          if (email) expect(email).toMatch(/@example\.(com|org|net)$/);
        }
      }
    }
  });

  it('defaults the threshold and the history', () => {
    const file = parseSuiteFile('t.json', base());
    expect(file.threshold).toBe(0.7);
    expect(file.cases[0]?.history).toEqual([]);
    expect(file.catalogues['main']?.[0]).toMatchObject({ active: true, aliases: [], examples: [] });
  });

  it.each([
    ['an unknown catalogue', withCase({ catalogue: 'nope' }), /Unknown catalogue/],
    ['labeled without a department', withCase({ expect: { status: 'labeled', departmentId: null } }), /exactly when status is labeled/],
    ['needs_review with a department', withCase({ expect: { status: 'needs_review', departmentId: 'billing' } }), /exactly when/],
    ['an inactive expected department', withCase({ expect: { status: 'labeled', departmentId: 'old' } }), /not active/],
    ['an override case without origin', withCase({ source: 'override' }), /origin/],
    [
      'history without the case email',
      withCase({
        history: [
          {
            ticket: { externalId: 'h', subject: 's', body: '', channel: 'email', email: 'a@example.com' },
            reply: { kind: 'error', status: 500 },
          },
        ],
      }),
      /email/,
    ],
    ['an overridden expectation', withCase({ expect: { status: 'overridden', departmentId: 'billing' } }), /status/],
    ['an expected category that is not in the catalogue', withCase({ expect: { status: 'labeled', departmentId: 'billing', categoryId: 'outage' } }), /category outage is not active/],
    ['a priority that is not one of the four', withCase({ expect: { status: 'labeled', departmentId: 'billing', priority: 'critical' } }), /priority/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseSuiteFile('t.json', input)).toThrow(message);
  });

  it('rejects a duplicate case id and names the file', () => {
    const file = base();
    const first = file.cases[0];
    if (!first) throw new Error('fixture');
    expect(() => parseSuiteFile('dup.json', { ...file, cases: [first, first] })).toThrow(/dup\.json.*Duplicate case id one/);
  });
});
