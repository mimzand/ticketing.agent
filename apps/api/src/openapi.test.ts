import { type AgentLink } from '@ticket/agent-client';
import { describe, expect, it } from 'vitest';
import { createApiApp } from './app.js';

const agent: AgentLink = {
  request: () => Promise.reject(new Error('unused')),
  ping: () => Promise.reject(new Error('unused')),
  close: () => undefined,
};

const app = createApiApp({ agent, apiKey: 'test-api-key', log: () => undefined });

describe('OpenAPI', () => {
  it('serves the document and Swagger UI without an API key', async () => {
    const docResponse = await app.request('/openapi.json');
    expect(docResponse.status).toBe(200);
    const doc = (await docResponse.json()) as {
      openapi: string;
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/health',
      '/v1/departments',
      '/v1/departments/{id}',
      '/v1/tickets',
      '/v1/tickets/{id}/override',
      '/v1/tickets:classify',
    ]);
    expect(doc.paths['/health']?.['get']?.security).toEqual([]);
    expect(doc.paths['/v1/tickets']?.['get']?.security).toEqual([{ apiKey: [] }, { bearer: [] }]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKey', 'bearer']);
    expect(JSON.stringify(doc)).not.toContain('$defs');
    expect(JSON.stringify(doc)).not.toContain('OLLAMA_TOKEN');

    const docs = await app.request('/docs');
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('/docs/swagger-ui-bundle.js');
    const init = await app.request('/docs/init.js');
    expect(await init.text()).toContain('persistAuthorization: false');
    const bundle = await app.request('/docs/swagger-ui-bundle.js');
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('content-type')).toContain('javascript');
    expect(bundle.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('still requires a key for ticket routes', async () => {
    expect((await app.request('/v1/tickets')).status).toBe(401);
  });
});

describe('OpenAPI from the shared schemas', () => {
  it('documents aliases, examples, the quote, the taxonomy version, and the 429', async () => {
    const doc = JSON.stringify(await (await app.request('/openapi.json')).json());
    const parsed = JSON.parse(doc) as {
      paths: Record<string, Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>>;
    };
    for (const word of ['"aliases"', '"examples"', '"quote"', '"taxonomyVersion"']) expect(doc).toContain(word);
    const classify = parsed.paths['/v1/tickets:classify']?.['post'];
    expect(Object.keys(classify?.responses ?? {})).toContain('429');
    expect(classify?.responses['429']?.headers).toHaveProperty('Retry-After');
    expect(parsed.paths['/health']?.['get']?.responses).not.toHaveProperty('429');
  });
});
