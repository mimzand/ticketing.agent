import { DecisionFeedbackSchema, type DecisionFeedback, type DecisionFeedbackItem } from '@ticket/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryFewShotCandidates, decisionFeedbackSuite } from './decision-feedback.js';
import { GOLDEN_DIR } from './load.js';
import { runSuite } from './run.js';
import { parseSuiteFile } from './suite.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(GOLDEN_DIR, '..', 'fixtures', name), 'utf8')) as unknown;
const sample = (): DecisionFeedback => DecisionFeedbackSchema.parse(fixture('decision-feedback.sample.json'));

const base: DecisionFeedbackItem = {
  ticketId: '00000000-0000-4000-8000-00000000d001',
  externalId: 'x-1',
  subject: 'Site down',
  body: 'The site is down.',
  channel: 'web',
  createdAt: '2026-11-24T00:00:00.000Z',
  status: 'labeled',
  departmentId: 'it',
  categoryReviewed: false,
  modelCategoryId: null,
  categoryId: null,
  priorityReviewed: false,
  modelPriority: null,
  priority: null,
  confidence: 0.8,
  rationale: 'r',
  quote: null,
  taxonomyVersion: 3,
};
const withItems = (...items: Partial<DecisionFeedbackItem>[]): DecisionFeedback => ({
  ...sample(),
  items: items.map((item, index) => ({
    ...base,
    ticketId: `00000000-0000-4000-8000-00000000d${String(index + 1).padStart(3, '0')}`,
    ...item,
  })),
});

describe('decision feedback → eval cases', () => {
  it('expects only the reviewed fields, with the admin values', () => {
    const { file } = decisionFeedbackSuite(
      withItems(
        { categoryReviewed: true, modelCategoryId: null, categoryId: 'outage', priority: 'high' },
        { priorityReviewed: true, modelPriority: 'normal', priority: 'urgent', categoryId: 'how-to' },
        { categoryReviewed: true, modelCategoryId: 'how-to', categoryId: 'outage', priorityReviewed: true, modelPriority: null, priority: 'low' },
      ),
    );
    const [categoryOnly, priorityOnly, both] = file?.cases ?? [];
    expect(categoryOnly?.expect).toEqual({ status: 'labeled', departmentId: 'it', confidence: 'above', categoryId: 'outage' });
    expect(priorityOnly?.expect).toEqual({ status: 'labeled', departmentId: 'it', confidence: 'above', priority: 'urgent' });
    expect(both?.expect).toEqual({ status: 'labeled', departmentId: 'it', confidence: 'above', categoryId: 'outage', priority: 'low' });
    expect(categoryOnly?.source).toBe('feedback');
    expect(categoryOnly?.feedbackOrigin).toEqual({
      ticketId: '00000000-0000-4000-8000-00000000d001',
      categoryReviewed: true,
      modelCategoryId: null,
      priorityReviewed: false,
      modelPriority: null,
      taxonomyVersion: 3,
    });
    // The wrong reply carries the model's values for the reviewed fields only.
    expect(categoryOnly?.wrongReply).toMatchObject({ output: { categoryId: null, priority: 'high' } });
    expect(priorityOnly?.wrongReply).toMatchObject({ output: { categoryId: 'how-to', priority: 'normal' } });
    expect(both?.wrongReply).toMatchObject({ output: { categoryId: 'how-to', priority: null } });
    expect(categoryOnly?.ticket).toEqual({ externalId: 'x-1', subject: 'Site down', body: 'The site is down.', channel: 'web' });
  });

  it('a confirmation is a positive case without a wrong reply', () => {
    const { file } = decisionFeedbackSuite(
      withItems({ categoryReviewed: true, modelCategoryId: 'outage', categoryId: 'outage', priorityReviewed: true, modelPriority: 'high', priority: 'high' }),
    );
    expect(file?.cases[0]?.wrongReply).toBeUndefined();
    expect(file?.cases[0]?.expect).toMatchObject({ categoryId: 'outage', priority: 'high' });
  });

  it('uses the stored active department, else the first active one, and skips when there is none', () => {
    const { file } = decisionFeedbackSuite(
      withItems({ priorityReviewed: true, priority: 'low', departmentId: 'billing' }, { priorityReviewed: true, priority: 'low', departmentId: 'facilities' }, { priorityReviewed: true, priority: 'low', departmentId: null, status: 'failed' }),
    );
    expect(file?.cases.map((c) => c.expect.departmentId)).toEqual(['billing', 'billing', 'billing']);
    const none = decisionFeedbackSuite({ ...withItems({ priorityReviewed: true, priority: 'low' }), departments: [] });
    expect(none.file).toBeNull();
    expect(none.skipped).toEqual([{ ticketId: '00000000-0000-4000-8000-00000000d001', reason: 'there is no active department for the placeholder reply' }]);
  });

  it('skips an inactive reviewed category and rows nobody reviewed', () => {
    const { file, skipped } = decisionFeedbackSuite(
      withItems({ categoryReviewed: true, categoryId: 'furniture' }, {}, { priorityReviewed: true, priority: 'urgent' }),
    );
    expect(file?.cases).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toEqual(['the reviewed category is not active', 'neither the category nor the priority was reviewed']);
  });

  it('generated cases pass through the real host, and their wrong replies are caught', async () => {
    const { file } = decisionFeedbackSuite(sample());
    if (!file) throw new Error('fixture');
    const run = await runSuite(file);
    expect(run.results.map((r) => [r.id, r.problems])).toEqual(run.results.map((r) => [r.id, []]));
    // A wrong reply that met the expectation would have failed the case: check one directly.
    const tampered = parseSuiteFile('t.json', {
      ...file,
      cases: [{ ...file.cases[0], wrongReply: file.cases[0]?.reply }],
    });
    expect((await runSuite(tampered)).results[0]?.problems[0]).toMatch(/wrongReply also meets/);
  }, 60_000);

  it('the checked-in sample artifacts are what the generator makes, and carry no email', () => {
    const cases = decisionFeedbackSuite(sample());
    const checkedIn = JSON.parse(readFileSync(join(GOLDEN_DIR, 'decision-feedback-sample.json'), 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(cases.file))).toEqual(checkedIn);
    const candidates = categoryFewShotCandidates(sample()).candidates;
    expect(candidates).toEqual(fixture('category-few-shot-candidates.sample.json'));
    // No sender field anywhere. The case keeps the ticket body as exported (an address
    // typed into the body stays there); the few-shot example redacts it.
    for (const text of [JSON.stringify(cases.file), JSON.stringify(candidates)]) expect(text).not.toContain('"email":');
    expect(JSON.stringify(candidates)).not.toContain('sam.sample@example.com');
    expect(JSON.stringify(candidates)).toContain('[email]');
  });
});

describe('category few-shot candidates', () => {
  it('keeps reviewed, active final categories, redacts addresses, and skips the rest', () => {
    const { candidates, skipped } = categoryFewShotCandidates(
      withItems(
        { categoryReviewed: true, categoryId: 'outage', subject: 'Down   again', body: 'Mail ops@corp.example.org now.' },
        { categoryReviewed: true, categoryId: 'furniture' },
        { categoryReviewed: true, categoryId: 'retired' },
        { categoryReviewed: true, categoryId: null },
        { priorityReviewed: true, priority: 'high' },
        { categoryReviewed: true, categoryId: 'outage', subject: 'The website returns error 500', body: '' },
        { categoryReviewed: true, categoryId: 'outage', subject: 'Down again', body: 'Mail ops@corp.example.org now.' },
      ),
    );
    expect(candidates).toEqual({
      formatVersion: 1,
      approval: 'operator',
      candidates: [
        {
          categoryId: 'outage',
          example: 'Down again — Mail [email] now.',
          modelCategoryId: null,
          ticketId: '00000000-0000-4000-8000-00000000d001',
          taxonomyVersion: 3,
        },
      ],
    });
    expect(skipped.map((s) => s.reason)).toEqual([
      'the category is not active',
      'the category no longer exists',
      'the reviewed category is empty',
      'the category was not reviewed',
      'the category already has this example',
      'the category already has this example',
    ]);
    // Read only: the catalogue in the export is unchanged.
    expect(sample().categories.find((c) => c.id === 'outage')?.examples).toEqual(['The website returns error 500']);
  });
});
