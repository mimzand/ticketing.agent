import { describe, expect, it } from 'vitest';
import {
  ClassifierOutputSchema,
  CreateCategorySchema,
  DecisionSchema,
  PRIORITY_TREND_MIN,
  priorityTrends,
  SetTicketPrioritySchema,
  TicketPrioritySchema,
  UpdateCategorySchema,
  type PriorityAggregate,
} from './index';

const row = (
  categoryId: string | null,
  priority: PriorityAggregate['priority'],
  replacedPriority: PriorityAggregate['replacedPriority'],
  count: number,
  reviewed = true,
): PriorityAggregate => ({ categoryId, priority, replacedPriority, reviewed, count });

describe('priority and category schemas', () => {
  it('accepts exactly the four priorities', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) expect(TicketPrioritySchema.parse(p)).toBe(p);
    for (const p of ['Low', 'critical', 'medium', '', null]) expect(TicketPrioritySchema.safeParse(p).success).toBe(false);
    expect(SetTicketPrioritySchema.safeParse({ id: '00000000-0000-4000-8000-000000000001', priority: 'High' }).success).toBe(false);
  });

  it('requires a default priority on create and keeps the id out of updates', () => {
    expect(CreateCategorySchema.safeParse({ id: 'outage', name: 'Outage', description: '' }).success).toBe(false);
    expect(CreateCategorySchema.parse({ id: 'outage', name: 'Outage', description: '', defaultPriority: 'urgent' })).toEqual({
      id: 'outage',
      name: 'Outage',
      description: '',
      defaultPriority: 'urgent',
      examples: [],
    });
    expect(CreateCategorySchema.safeParse({ id: 'Outage!', name: 'x', description: '', defaultPriority: 'low' }).success).toBe(false);
    expect(CreateCategorySchema.safeParse({ id: 'x', name: 'x', description: '', defaultPriority: 'low', aliases: [] }).success).toBe(false);
    expect(
      CreateCategorySchema.safeParse({ id: 'x', name: 'x', description: '', defaultPriority: 'low', examples: ['y'.repeat(301)] })
        .success,
    ).toBe(false);
    expect(UpdateCategorySchema.safeParse({ id: 'outage' }).success).toBe(false);
    expect(UpdateCategorySchema.safeParse({ id: 'outage', newId: 'x', active: false }).success).toBe(false);
    expect(UpdateCategorySchema.parse({ id: 'outage', defaultPriority: 'high' })).toEqual({ id: 'outage', defaultPriority: 'high' });
  });

  it('decisions carry category and priority fields', () => {
    const base = { departmentId: null, confidence: 0, rationale: '', status: 'failed', quote: null, taxonomyVersion: 0 };
    expect(DecisionSchema.safeParse(base).success).toBe(false);
    expect(
      DecisionSchema.safeParse({
        ...base,
        categoryId: null,
        replacedCategoryId: null,
        categoryReviewed: false,
        priority: null,
        replacedPriority: null,
        priorityReviewed: false,
      }).success,
    ).toBe(true);
  });

  it('classifier output: category and priority are optional, and a wrong type reads as null', () => {
    const base = { departmentId: 'billing', confidence: 0.9, rationale: 'r' };
    expect(ClassifierOutputSchema.parse(base)).toEqual(base);
    expect(ClassifierOutputSchema.parse({ ...base, categoryId: 'outage', priority: 'high' })).toMatchObject({
      categoryId: 'outage',
      priority: 'high',
    });
    expect(ClassifierOutputSchema.parse({ ...base, categoryId: 7, priority: { p: 1 } })).toMatchObject({
      departmentId: 'billing',
      categoryId: null,
      priority: null,
    });
    // Strings that are not valid values still parse; the host decides.
    expect(ClassifierOutputSchema.parse({ ...base, priority: 'critical' }).priority).toBe('critical');
  });
});

describe('priorityTrends', () => {
  it(`needs at least ${PRIORITY_TREND_MIN} reviewed tickets in a category`, () => {
    expect(priorityTrends([row('outage', 'urgent', 'high', 4)])).toEqual([]);
    expect(priorityTrends([row('outage', 'urgent', 'high', 4), row('outage', 'high', 'high', 1)])).toEqual([
      {
        categoryId: 'outage',
        reviewed: 5,
        modal: 'urgent',
        modalCount: 4,
        modelSaid: 'high',
        modelSaidCount: 4,
        line: 'outage: 5 reviewed; admin result urgent 4/5. Of those 4, the model had said high on 4.',
      },
    ]);
  });

  it('breaks ties urgent, then high, normal, low, for both the admin result and the model priority', () => {
    const [trend] = priorityTrends([
      row('billing', 'low', 'normal', 3),
      row('billing', 'normal', 'low', 2),
      row('billing', 'normal', 'urgent', 1),
      row('billing', 'high', 'normal', 1),
    ]);
    // low 3 vs normal 3 → normal; among normal rows: low 2 vs urgent 1 → low.
    expect(trend?.line).toBe('billing: 7 reviewed; admin result normal 3/7. Of those 3, the model had said low on 2.');
    const [tie] = priorityTrends([
      row('net', 'high', 'low', 1),
      row('net', 'high', 'urgent', 1),
      row('net', 'urgent', 'normal', 2),
      row('net', 'high', 'normal', 1),
      row('net', 'low', 'low', 1),
    ]);
    // high 3 vs urgent 2 → high; among high: low 1, urgent 1, normal 1 → urgent.
    expect(tie).toMatchObject({ modal: 'high', modalCount: 3, modelSaid: 'urgent', modelSaidCount: 1 });
  });

  it('reports a null model priority as none, after real priorities on a tie', () => {
    expect(priorityTrends([row('hw', 'high', null, 5)])[0]?.line).toBe(
      'hw: 5 reviewed; admin result high 5/5. Of those 5, the model had said none on 5.',
    );
    expect(priorityTrends([row('hw', 'high', null, 3), row('hw', 'high', 'low', 3)])[0]).toMatchObject({
      modelSaid: 'low',
      modelSaidCount: 3,
    });
  });

  it('ignores rows the caller did not mark reviewed and rows without a final category or priority', () => {
    expect(
      priorityTrends([
        row('outage', 'urgent', null, 50, false),
        row('outage', 'urgent', 'urgent', 4),
        row(null, 'urgent', 'urgent', 10),
        row('outage', null, 'urgent', 10),
      ]),
    ).toEqual([]);
  });

  it('sorts lines by category id', () => {
    const lines = priorityTrends([row('zeta', 'low', 'low', 5), row('alpha', 'high', 'high', 5)]).map((t) => t.categoryId);
    expect(lines).toEqual(['alpha', 'zeta']);
  });
});
