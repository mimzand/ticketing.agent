import { DepartmentAliasesSchema, DepartmentExamplesSchema } from '@ticket/shared';

/** One entry per line; blank lines are dropped. Used for aliases and examples. */
export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export const listToLines = (list: readonly string[]): string => list.join('\n');

/** The first problem with the alias and example lists, or null. */
export function listProblem(aliasesText: string, examplesText: string): string | null {
  const aliases = DepartmentAliasesSchema.safeParse(linesToList(aliasesText));
  if (!aliases.success) return `Aliases: ${aliases.error.issues[0]?.message ?? 'invalid.'}`;
  const examples = DepartmentExamplesSchema.safeParse(linesToList(examplesText));
  if (!examples.success) return `Examples: ${examples.error.issues[0]?.message ?? 'invalid.'}`;
  return null;
}
