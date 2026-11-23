# Ticketing Agent — context

This repository: https://github.com/redrock-technology/redrock.ticketing.agent

Pattern source (read only): `C:\Users\zandm\Projects\Algoalliance\ai.agents\sample-agent`. Do not modify it. Do not copy its tree. Its package names are `@rka/*`; this repo uses `@ticket/*` and must not depend on `@rka/*`.

Paste one prompt per fresh Claude session, after the previous phase is done. Do not redo finished work.

## Product

Windows desktop app. An operator submits a ticket; the agent assigns one organization department and stores that label. Low confidence or an unknown department stays `needs_review` for a human override.

Three processes. Electron is only a client of the HTTP API. A later frontend calls that same API.

```text
Vue renderer → preload window.api → Electron main
                                        │  HTTP, API key
                                        ▼
                                   apps/api     Hono, 127.0.0.1:8787. No database, no ADK
                                        │  HTTP on 127.0.0.1 only
                                        ▼
                                   apps/agent   SQLite + ADK classifier
```

`apps/agent` is the only process that opens SQLite or calls Ollama. `apps/api` forwards to it and never imports `electron`.

## Decisions

- Yarn 4 workspaces, Corepack, `nodeLinker: node-modules`. Workspaces are `apps/*` and `packages/*`. Node 22.12+. No pnpm.
- `packages/contracts` (`@ticket/contracts`): Zod schemas shared by the agent, the API, and the desktop. No Node, no Electron, no other workspace packages.
- `apps/agent` (`@ticket/agent`): SQLite (`better-sqlite3` + Drizzle) and the classifier. Listens on `127.0.0.1` only (`AGENT_HOST`, `AGENT_PORT`, default `127.0.0.1:8788`). No Electron. No API key; this port is not the product API.
- `apps/api` (`@ticket/api`): Hono on `127.0.0.1:8787` (`API_HOST`, `API_PORT`). No database. Forwards to the agent over HTTP.
- `apps/desktop` (`@ticket/desktop`): Electron, Vue 3, TypeScript, Vite. No database. No Ollama calls. The main process calls the HTTP API. It does not call the agent.
- Agent: `@google/adk` only, inside `apps/agent`, as modules. No Legacy runtime, no engine switch. Do not add `packages/ollama`, `packages/adk`, `packages/model-provider`, `packages/adk-runtime`, `packages/storage`, `packages/agent-host`, `packages/agent-runtime`, `packages/agent-protocol`, `packages/agent-client`, or `packages/tools`.
- Model: company Ollama only (`OLLAMA_HOST`, `OLLAMA_MODEL`). Construct `new OllamaLlm(...)`. No Gemini model name, no OpenAI, no cloud LLM, no web search.
- Before importing `@google/adk`, strip the names listed in the pattern source `packages/adk-runtime/src/env.ts` (`TELEMETRY_ENV_VARS`, `CLOUD_ENV_VARS`, and `ADK_FEATURE_FLAG_PATTERN`). Set `OTEL_SDK_DISABLED=true` and `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`.
- Ollama HTTP follows `packages/model-provider/src/ollama/provider.ts`: `http:` or `https:` only, no userinfo, query, or fragment, `redirect: 'manual'`, bearer token only for HTTPS or loopback, `AbortSignal`, timeouts.
- Electron's postinstall must run, because it downloads the Electron binary. From phase 2, set `better-sqlite3` `dependenciesMeta.built` to `false` so Yarn keeps the prebuilt binary and does not compile it. Do not copy the pattern source's `pnpm-workspace.yaml`.
- The desktop package may depend only on `@ticket/contracts`. Only `apps/desktop` may import `electron`. Enforce that with ESLint `no-restricted-imports`.
- Patterns, not files to copy:
  - `apps/desktop/src/main/window.ts`
  - `apps/desktop/src/main/security.ts`
  - `apps/api/src/security.ts`
  - `packages/adk-runtime/src/env.ts`
  - `packages/adk-runtime/src/ollama/ollama-llm.ts`
  - `packages/storage/src/schema.ts` (migration shape only; not the research tables)

Leave out of v1: research tools, the loopback agent protocol (frames, handshake, state file), code execution, `dockerode`, Swagger, rate limits, CORS lists, pagination, idempotency-key conflicts, a safeStorage settings UI, a second client package. The desktop connects to an API that is already running. It does not spawn the agent or the API.

## v1 shape

Departments: `id`, `name`, `description`, `active`.

Tickets: `id`, unique `externalId`, `subject`, `body`, `channel`, `createdAt`.

Decision: `departmentId` or null, `confidence` (0–1), `rationale`, `status` (`labeled` | `needs_review` | `overridden` | `failed`). Threshold `CLASSIFY_MIN_CONFIDENCE`, default `0.7`. An unknown department or low confidence becomes `needs_review` with no applied label.

SQLite file: `TICKET_DATA_DIR` (default `apps/agent/.data/tickets.db`). The agent applies Drizzle migrations on startup. Gitignore `.data`. Electron and the API never open this file.

The agent exposes the operations below on its loopback HTTP port. The product routes are the API routes. The API forwards each one and does not classify.

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | public |
| `GET` `POST` | `/v1/departments` | API key |
| `POST` | `/v1/tickets:classify` | API key |
| `GET` | `/v1/tickets` | API key |
| `POST` | `/v1/tickets/{id}/override` | API key |

`GET /v1/tickets` returns the most recent tickets, capped at 50. No page query.

`X-API-Key` or `Authorization: Bearer`, compared in constant time on a digest. On loopback, generate a key for the API process when `API_KEY` is unset and print it once. Responses never include the Ollama token.

`GET /health` returns `{ "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable" }`. From phase 2 it also reports whether Ollama is reachable and the configured model name.

The same `externalId` returns the stored decision and does not call the model again. That check lives in the agent. Override accepts only an active department and sets `overridden`.

Electron window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. The renderer talks only through a fixed `window.api`. Ticket text is plain text. The renderer never sees the API key.

## Later

Evidence quotes, department examples and aliases, taxonomy versions, OpenAPI/Swagger, the loopback agent protocol, a non-Electron client, spawning the agent from Electron, a settings screen with `safeStorage`, abort end to end, crash recovery, log redaction tests, rate limit, CORS. Do not build these unless a prompt asks for them.

---

## Prompt 1 — Scaffold

```text
Read docs/context.md. Implement only the v1 scaffold. Stop before SQLite, ADK, Ollama, and the ticket UI.

Yarn 4 workspace (Corepack, nodeLinker: node-modules) with @ticket/contracts, @ticket/agent, @ticket/api, and @ticket/desktop.
- Agent: GET /health on 127.0.0.1:8788 returns { "ok": true, "service": "ticket-agent" }, validated by a Zod schema in @ticket/contracts. Bind loopback only.
- API: GET /health returns { "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable" }, validated by a Zod schema in @ticket/contracts. The API calls the agent over HTTP and does nothing else with that response.
- Desktop: one window that shows the API health result. Preload exposes only getHealth. Main reads API_BASE_URL (default http://127.0.0.1:8787). The renderer has no Node and no network of its own. The desktop does not call the agent.
- TypeScript strict, ESM, Vitest, ESLint. The desktop package may depend only on @ticket/contracts. Only the desktop package may import electron.
- Root scripts: agent:dev, api:dev, api:up (agent and api together), dev for the desktop, typecheck, test, lint.
- .yarnrc.yml: nodeLinker node-modules. Electron's postinstall must be allowed to run.
- Tests: /health matches the schema when the agent is up and when it is down; BrowserWindow uses the four isolation flags from the context.
- README: Node 22.12+, Yarn 4, and the dev commands (yarn). Point at this file.

Do not copy the sample-agent tree. Do not add a frame protocol, a state file, or extra packages. Run typecheck, test, and lint.
```

## Prompt 2 — Agent classifier and API

```text
Read docs/context.md. Phase 1 is done. Add SQLite, the ADK classifier, and the HTTP routes. Do not build the ticket UI. Do not add the "Later" items.

Inside apps/agent, not in a new package:
- SQLite at TICKET_DATA_DIR (default apps/agent/.data/tickets.db). Apply Drizzle migrations on startup. Tables for departments, tickets, and decisions, matching the v1 shape. Zod schemas live in @ticket/contracts. Set better-sqlite3 dependenciesMeta.built to false. Electron and the API never open this file.
- Modules for the Ollama HTTP client and an ADK OllamaLlm. Follow the host rules in the context. The agent is one LlmAgent with outputSchema departmentId, confidence, rationale. Ticket text goes in the user message as untrusted data, not in the system instruction.
- Classify in code after the model returns: active department ids only, confidence >= CLASSIFY_MIN_CONFIDENCE, otherwise needs_review. Network or model errors are status failed. Persist the decision.
- Serve the operations on the agent port. The API routes from the context table forward to them and do not classify. API key auth except /health. /health also reports ollama reachable or unreachable and the configured model name, never the token. Same externalId returns the stored decision without a second model call. Override accepts only an active department and sets overridden.

Tests use a fake Ollama HTTP server, not the company server: valid label, unknown department, low confidence, Ollama down, missing API key, repeat externalId. Also test that sanitize removes a dummy GOOGLE_API_KEY before ADK loads; do not print the value.

Run typecheck, test, and lint. Add a curl example to the README.
```

## Prompt 3 — Electron client

```text
Read docs/context.md. Phases 1 and 2 are done. Build the v1 desktop client. Do not change the agent or the API unless a phase 2 test is failing. Do not add the "Later" items.

One Vue 3 screen, Composition API, no UI library. The main process calls the HTTP API. The renderer never calls fetch and never sees the API key.
- API health.
- Create department (id, name, description).
- Submit ticket (externalId, subject, body, channel) and show status, department, confidence, and rationale as plain text.
- List recent tickets.
- Override a ticket by picking an active department.

API_BASE_URL and API_KEY come from the environment via the main process. Keep the preload as a fixed window.api. Validate responses with @ticket/contracts in the main process. Disable the submit button while a request is in flight.

Test the screen state for a labeled result and a needs_review result with no department applied. Run typecheck, test, and lint. In the summary, say how to run the agent, the API, and the desktop app together.
```
