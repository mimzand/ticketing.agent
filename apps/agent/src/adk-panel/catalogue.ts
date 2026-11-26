import { TicketPrioritySchema } from '@ticket/shared';
import { z } from 'zod';

/**
 * What the ADK panel's classifier is built from. Written once at startup and
 * read by the agent file. No token, no ticket text, no sender.
 */
export const PanelCatalogueSchema = z.strictObject({
  ollama: z.strictObject({
    baseUrl: z.string().min(1),
    model: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    generateTimeoutMs: z.number().int().positive(),
  }),
  departments: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      aliases: z.array(z.string()),
      examples: z.array(z.string()),
    }),
  ),
  categories: z.strictObject({
    categories: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        defaultPriority: TicketPrioritySchema,
        examples: z.array(z.string()),
      }),
    ),
    priorityTrends: z.array(
      z.strictObject({
        categoryId: z.string(),
        line: z.string(),
      }),
    ),
  }),
});

export type PanelCatalogue = z.infer<typeof PanelCatalogueSchema>;
