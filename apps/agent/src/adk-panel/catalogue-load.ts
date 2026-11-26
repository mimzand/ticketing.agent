import { resolveSettings } from '@ticket/agent-host';
import { priorityTrends } from '@ticket/shared';
import { type TicketDatabase } from '@ticket/storage';
import { type PanelCatalogue } from './catalogue.js';

/**
 * Active departments and categories, the admin priority lines, and the Ollama
 * settings the next classify would use. The caller closes the database; this
 * does not keep it open.
 */
export function loadPanelCatalogue(db: TicketDatabase, env: NodeJS.ProcessEnv): PanelCatalogue {
  const { values } = resolveSettings(db.readSettings(), env);
  const departments = db
    .listDepartments()
    .filter((department) => department.active)
    .map((department) => ({
      id: department.id,
      name: department.name,
      description: department.description,
      aliases: [...department.aliases],
      examples: [...department.examples],
    }));
  const categories = db
    .listCategories()
    .filter((category) => category.active)
    .map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      defaultPriority: category.defaultPriority,
      examples: [...category.examples],
    }));
  const listed = new Set(categories.map((category) => category.id));
  return {
    ollama: {
      baseUrl: values.ollamaBaseUrl,
      model: values.model,
      timeoutMs: values.connectTimeoutMs,
      generateTimeoutMs: values.classifyTimeoutMs,
    },
    departments,
    categories: {
      categories,
      priorityTrends: priorityTrends(db.priorityAggregates())
        .filter((trend) => listed.has(trend.categoryId))
        .map((trend) => ({ categoryId: trend.categoryId, line: trend.line })),
    },
  };
}
