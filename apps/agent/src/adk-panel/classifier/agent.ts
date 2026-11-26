import { createClassifierAgent, sanitizeAdkEnvironment } from '@ticket/adk-runtime';
import { createOllamaClient } from '@ticket/model-provider';
import { readFileSync } from 'node:fs';
import { PanelCatalogueSchema } from '../catalogue.js';

// The devtools process may load a .env after the launcher sanitised the
// environment. Strip cloud and telemetry names again before the classifier is built.
sanitizeAdkEnvironment(process.env);

const snapshotPath = process.env['TICKET_ADK_PANEL_SNAPSHOT']?.trim();
if (!snapshotPath) {
  throw new Error('Start the ADK panel with yarn adk:web.');
}

const catalogue = PanelCatalogueSchema.parse(JSON.parse(readFileSync(snapshotPath, 'utf8')) as unknown);
const token = process.env['OLLAMA_TOKEN']?.trim() || undefined;

/** The agent the ADK dev panel lists. One Ollama classifier, no tools. */
export const rootAgent = await createClassifierAgent({
  ollama: createOllamaClient({ ...catalogue.ollama, token }),
  departments: catalogue.departments,
  categories: catalogue.categories,
});
