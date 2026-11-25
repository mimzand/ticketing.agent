import { describe, expect, it } from 'vitest';
import { categoryExamplesProblem, parseCategoryForm, PRIORITY_OPTIONS } from './category-form.js';

const form = { id: 'outage', name: 'Outage', description: 'Down', defaultPriority: 'urgent' as const, examples: 'Site down\n\n API 500 ' };

describe('category form', () => {
  it('lists the four priorities', () => {
    expect(PRIORITY_OPTIONS).toEqual(['low', 'normal', 'high', 'urgent']);
  });

  it('builds a create request from the form', () => {
    expect(parseCategoryForm(form)).toEqual({
      ok: true,
      value: { id: 'outage', name: 'Outage', description: 'Down', defaultPriority: 'urgent', examples: ['Site down', 'API 500'] },
    });
  });

  it('requires a default priority and a valid id, and applies the department example limits', () => {
    expect(parseCategoryForm({ ...form, defaultPriority: '' })).toEqual({ ok: false, error: 'Choose a default priority.' });
    expect(parseCategoryForm({ ...form, id: 'Not Valid' })).toMatchObject({ ok: false });
    expect(categoryExamplesProblem('y'.repeat(301))).toMatch(/300 characters/);
    expect(categoryExamplesProblem(Array.from({ length: 21 }, (_, i) => `e${i}`).join('\n'))).toMatch(/At most 20 examples/);
    expect(categoryExamplesProblem('a\na')).toMatch(/twice/);
    expect(categoryExamplesProblem('')).toBeNull();
  });
});
