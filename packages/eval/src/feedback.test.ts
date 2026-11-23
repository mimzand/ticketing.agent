import { createAgentHost } from '@ticket/agent-host';
import { OverrideFeedbackSchema } from '@ticket/shared';
import { openTicketDatabase } from '@ticket/storage';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeOllama, FAKE_OLLAMA_BASE_URL, FAKE_OLLAMA_MODEL } from './fake-ollama.js';
import { exampleSnippet, fewShotCandidates, overrideSuiteFromFeedback } from './feedback.js';
import { GOLDEN_DIR } from './load.js';
import { runSuite } from './run.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(GOLDEN_DIR, '..', 'fixtures', name), 'utf8')) as unknown;

describe('override feedback → eval cases and few-shot candidates', () => {
  it('a real classify + override exports both ids, yields a case expecting the operator department, and no email', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-eval-feedback-'));
    const db = openTicketDatabase(join(dir, 'tickets.db'));
    try {
      const fake = createFakeOllama([
        {
          kind: 'scripted',
          output: { departmentId: 'billing', confidence: 0.88, rationale: 'Mentions an invoice.', quote: 'Invoice for the dock' },
        },
      ]);
      const host = createAgentHost({
        db,
        env: { OLLAMA_HOST: FAKE_OLLAMA_BASE_URL, OLLAMA_MODEL: FAKE_OLLAMA_MODEL },
        fetch: fake.fetch,
      });
      host.createDepartment({ id: 'billing', name: 'Billing', description: 'Invoices' });
      host.createDepartment({ id: 'it', name: 'IT', description: 'Computers' });
      const view = await host.classify({
        externalId: 'fb-1',
        subject: 'Invoice for the dock that never came',
        body: 'The USB-C dock was not delivered. Write to lee.sample@example.com.',
        channel: 'email',
        email: 'Lee.Sample@example.com',
      });
      expect(view.decision).toMatchObject({ status: 'labeled', departmentId: 'billing' });
      host.override({ id: view.id, departmentId: 'it' });

      // (a) the export carries the classifier department and the operator department.
      const exported = host.overrideFeedback();
      expect(exported.items).toHaveLength(1);
      expect(exported.items[0]).toMatchObject({ ticketId: view.id, replacedDepartmentId: 'billing', departmentId: 'it' });

      // (c) no sender email in the serialized default export (the body text is the ticket's own).
      const serialized = JSON.stringify(exported);
      expect(serialized).not.toContain('"email":');
      expect(serialized).not.toMatch(/Lee\.Sample@example\.com/);
      expect(Object.keys(exported.items[0] ?? {})).not.toContain('email');

      // (b) the generated case expects the operator department and passes; the old answer would not.
      const { file, skipped } = overrideSuiteFromFeedback(OverrideFeedbackSchema.parse(JSON.parse(serialized)));
      expect(skipped).toEqual([]);
      expect(file.cases).toHaveLength(1);
      expect(file.cases[0]).toMatchObject({
        source: 'override',
        expect: { status: 'labeled', departmentId: 'it' },
        wrongReply: { kind: 'scripted', output: { departmentId: 'billing', confidence: 0.88 } },
        origin: { ticketId: view.id, replacedDepartmentId: 'billing' },
      });
      expect(file.cases[0]?.ticket).not.toHaveProperty('email');
      const run = await runSuite(file);
      expect(run.results[0]).toMatchObject({ passed: true, actual: { status: 'labeled', departmentId: 'it' } });

      const { candidates } = fewShotCandidates(exported);
      expect(candidates.candidates).toEqual([
        {
          departmentId: 'it',
          example: 'Invoice for the dock that never came — The USB-C dock was not delivered. Write to [email].',
          replacedDepartmentId: 'billing',
          ticketId: view.id,
          taxonomyVersion: exported.items[0]?.taxonomyVersion,
        },
      ]);
      // Candidates only: the catalogue is unchanged.
      expect(host.listDepartments().find((d) => d.id === 'it')?.examples).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('the checked-in sample artifacts are what the generator makes from the sample export', () => {
    const sample = OverrideFeedbackSchema.parse(fixture('override-feedback.sample.json'));
    const cases = overrideSuiteFromFeedback(sample);
    expect(cases.skipped).toEqual([
      { ticketId: '00000000-0000-4000-8000-00000000a003', reason: 'the operator department is not active' },
    ]);
    const checkedIn = JSON.parse(readFileSync(join(GOLDEN_DIR, 'overrides-sample.json'), 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(cases.file))).toEqual(checkedIn);
    expect(fewShotCandidates(sample).candidates).toEqual(fixture('few-shot-candidates.sample.json'));
    for (const text of [JSON.stringify(cases.file), JSON.stringify(fewShotCandidates(sample).candidates)]) {
      expect(text).not.toContain('"email":');
    }
  });

  it('skips overrides that kept the classifier department or already-known examples', () => {
    const sample = OverrideFeedbackSchema.parse(fixture('override-feedback.sample.json'));
    const [first] = sample.items;
    if (!first) throw new Error('fixture');
    const same = { ...first, ticketId: '00000000-0000-4000-8000-00000000b001', departmentId: first.replacedDepartmentId };
    const known = {
      ...sample,
      departments: sample.departments.map((d) =>
        d.id === 'it' ? { ...d, examples: [exampleSnippet(first.subject, first.body).toUpperCase()] } : d,
      ),
      items: [first, same],
    };
    expect(overrideSuiteFromFeedback(known).skipped).toEqual([
      { ticketId: same.ticketId, reason: 'the operator kept the classifier department' },
    ]);
    expect(fewShotCandidates(known).skipped.map((s) => s.reason)).toEqual([
      'the department already has this example',
      'the operator kept the classifier department',
    ]);
  });

  it('makes short examples within the department limit', () => {
    expect(exampleSnippet('  Two\nlines ', 'Mail a.b@corp.example.org now.')).toBe('Two lines — Mail [email] now.');
    expect(exampleSnippet('Only a subject', '')).toBe('Only a subject');
    const long = exampleSnippet('S', 'x'.repeat(1000));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});
