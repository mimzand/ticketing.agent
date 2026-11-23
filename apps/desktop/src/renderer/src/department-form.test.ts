import { describe, expect, it } from 'vitest';
import { linesToList, listProblem, listToLines } from './department-form.js';

describe('department form lists', () => {
  it('turns lines into a list and back', () => {
    expect(linesToList(' Accounts payable \n\n AP ')).toEqual(['Accounts payable', 'AP']);
    expect(listToLines(['a', 'b'])).toBe('a\nb');
  });

  it('reports the limits from the shared schemas', () => {
    expect(listProblem('a\nb', 'x')).toBeNull();
    expect(listProblem(Array.from({ length: 21 }, (_, i) => `a${i}`).join('\n'), '')).toMatch(/At most 20 aliases/);
    expect(listProblem('x'.repeat(65), '')).toMatch(/64 characters/);
    expect(listProblem('AP\nap', '')).toMatch(/twice/);
    expect(listProblem('', 'y'.repeat(301))).toMatch(/300 characters/);
  });
});
