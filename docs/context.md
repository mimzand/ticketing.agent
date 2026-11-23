# Ticketing Agent — context

This repository: https://github.com/redrock-technology/redrock.ticketing.agent

Pattern source (read only): `C:\Users\zandm\Projects\Algoalliance\ai.agents\sample-agent`. Do not modify it. Do not copy its tree. Its package names are `@rka/*`; this repo uses `@ticket/*` and must not depend on `@rka/*`.

Paste one prompt per fresh Claude session, after the previous phase is done. Do not redo finished work.

## Product

Windows desktop app. An operator submits a ticket; the agent assigns one organization department and stores that label. Low confidence or an unknown department stays `needs_review` for a human override.

Three processes, matching the pattern source:

```text
Vue renderer → preload window.api → Electron main
                                        │  @ticket/agent-client
                                        ▼
                                   apps/agent   SQLite + ADK classifier, 127.0.0.1 only
                                        ▲
                                   apps/api     Hono HTTP, no database, no ADK
                                        ▲
                                another frontend later
```

Electron is a shell. It does not open the database and does not call Ollama. `apps/agent` is the only process that owns SQLite and the model. `apps/api` is the HTTP front for other clients. It uses the same loopback protocol and never imports `electron`.

## Decisions

- pnpm workspaces, `apps/*` and `packages/*`. Node 22.12+, pnpm 11.9+. No Yarn.
- `packages/shared` (`@ticket/shared`): Zod schemas. No Node, no Electron, no other workspace packages.
- `packages/storage` (`@ticket/storage`): SQLite (`better-sqlite3` + Drizzle). Only `apps/agent` may import it. Added in phase 2.
- `packages/agent-protocol` (`@ticket/agent-protocol`): handshake, length-prefixed frames, method names. Depends only on `@ticket/shared`. No Node APIs. Protocol name `ticket-agent`, version 1. The bind address and the state-file host are `127.0.0.1` only.
- `packages/agent-client` (`@ticket/agent-client`): Node client for that protocol. Electron main and `apps/api` use it. It never imports `electron`. The renderer and the preload never import it.
- `apps/agent` (`@ticket/agent`): protocol server on `127.0.0.1`. No Electron. Writes a state file (host, port, token, pid). Default path `apps/agent/.agent-data/agent-state.json`, override `AGENT_STATE_FILE`. Gitignore that directory.
- `apps/api` (`@ticket/api`): Hono on `127.0.0.1:8787` (`API_HOST`, `API_PORT`). No database. Finds the agent through the state file.
- `apps/desktop` (`@ticket/desktop`): Electron, Vue 3, TypeScript, Vite. The main process connects to the agent. It does not call the HTTP API.
- Model code stays inside `apps/agent`, as modules, not packages. `@google/adk` is imported only there. No Legacy runtime and no engine switch. Do not add `packages/model-provider`, `packages/adk-runtime`, `packages/agent-host`, `packages/agent-runtime`, or `packages/tools`.
- Model: company Ollama only (`OLLAMA_HOST`, `OLLAMA_MODEL`). Construct `new OllamaLlm(...)`. No Gemini model name, no OpenAI, no cloud LLM, no web search.
- Before importing `@google/adk`, strip the names listed in the pattern source `packages/adk-runtime/src/env.ts` (`TELEMETRY_ENV_VARS`, `CLOUD_ENV_VARS`, and `ADK_FEATURE_FLAG_PATTERN`). Set `OTEL_SDK_DISABLED=true` and `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`.
- Ollama HTTP follows `packages/model-provider/src/ollama/provider.ts`: `http:` or `https:` only, no userinfo, query, or fragment, `redirect: 'manual'`, bearer token only for HTTPS or loopback, `AbortSignal`, timeouts.
- `pnpm-workspace.yaml` `allowBuilds`: `electron: true`. From phase 2, `better-sqlite3: false` (use the prebuilt binary). Do not copy the pattern source's other `allowBuilds` entries.
- Only `apps/desktop` may import `electron`. Enforce the boundaries with ESLint `no-restricted-imports`.
- Patterns, not files to copy:
  - `apps/desktop/src/main/window.ts`
  - `apps/desktop/src/main/security.ts`
  - `apps/api/src/security.ts`
  - `apps/api/src/agent-link.ts`
  - `apps/agent/src/state-file.ts`
  - `apps/agent/src/server.ts`
  - `packages/agent-protocol/src/handshake.ts`
  - `packages/agent-protocol/src/framing.ts`
  - `packages/agent-client/src/connect.ts`
  - `packages/adk-runtime/src/env.ts`
  - `packages/adk-runtime/src/ollama/ollama-llm.ts`
  - `packages/storage/src/schema.ts` (migration shape only; not the research tables)

Leave out of v1: research, chat, tools, the legacy engine, an engine flag, an Electron utility-process supervisor, an in-process agent, reverse calls into the shell, `safeStorage`, OpenAPI/Swagger, rate limits, CORS lists, pagination, idempotency-key conflicts, a second UI package. The desktop connects to an agent that is already running. It does not spawn one.

## v1 shape

Departments: `id`, `name`, `description`, `active`.

Tickets: `id`, unique `externalId`, `subject`, `body`, `channel`, `createdAt`.

Decision: `departmentId` or null, `confidence` (0–1), `rationale`, `status` (`labeled` | `needs_review` | `overridden` | `failed`). Threshold `CLASSIFY_MIN_CONFIDENCE`, default `0.7`. An unknown department or low confidence becomes `needs_review` with no applied label.

SQLite file: `TICKET_DATA_DIR` (default `apps/agent/.data/tickets.db`). The agent applies Drizzle migrations on startup. Gitignore `.data`.

Protocol methods, after `system.hello`:

| Method | Purpose |
| --- | --- |
| `system.ping` | liveness |
| `departments.list` | every department |
| `departments.create` | `id`, `name`, `description` |
| `tickets.classify` | store the ticket and return the decision; same `externalId` returns the stored decision |
| `tickets.list` | the 50 most recent tickets |
| `tickets.override` | an active department only; status becomes `overridden` |

HTTP routes. Each one forwards to the method above. The API does not classify and does not open SQLite.

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | public |
| `GET` `POST` | `/v1/departments` | API key |
| `POST` | `/v1/tickets:classify` | API key |
| `GET` | `/v1/tickets` | API key |
| `POST` | `/v1/tickets/{id}/override` | API key |

`X-API-Key` or `Authorization: Bearer`, compared in constant time on a digest. On loopback, generate a key for the process when `API_KEY` is unset and print it once. Responses never include the agent token or the Ollama token.

`GET /health` returns `{ "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable" }`. From phase 2 it also reports whether Ollama is reachable and the configured model name.

Electron window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. The renderer talks only through a fixed `window.api`. Ticket text is plain text. The renderer never sees the agent token or the API key.

## Later

Evidence quotes, department examples and aliases, taxonomy versions, OpenAPI/Swagger, spawning the agent from Electron, a settings screen with `safeStorage`, abort end to end, crash recovery, log redaction tests, rate limit, CORS. Do not build these unless a prompt asks for them.

---

## Prompt 1 — Scaffold

```text
Read docs/context.md. Implement only the v1 scaffold. Stop before SQLite, ADK, Ollama, and the ticket UI.

pnpm workspace with @ticket/shared, @ticket/agent-protocol, @ticket/agent-client, @ticket/agent, @ticket/api, and @ticket/desktop.
- Agent: listen on 127.0.0.1, write the state file, accept system.hello then system.ping. Reject any other first message and a wrong token. The token comparison is constant-time. The state file names 127.0.0.1 only.
- API: GET /health returns { "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable" }, validated by a Zod schema in @ticket/shared. The API reaches the agent only through @ticket/agent-client.
- Desktop: one window that shows the agent ping. Preload exposes only getHealth. Main reads AGENT_STATE_FILE and uses @ticket/agent-client. The renderer has no Node and no network of its own. The desktop does not call the HTTP API.
- TypeScript strict, ESM, Vitest, ESLint with the import boundaries from the context. Only the desktop package may import electron.
- Root scripts: agent:dev, api:dev, api:up (agent and api together), dev for the desktop, typecheck, test, lint.
- pnpm-workspace.yaml allowBuilds: electron true.
- Tests: /health matches the schema when the agent is up and when it is down; a bad token is rejected; BrowserWindow uses the four isolation flags from the context.
- README: Node 22.12+, pnpm 11.9+, and the three dev commands. Point at this file.

Do not copy the sample-agent tree. Run typecheck, test, and lint.
```

## Prompt 2 — Agent classifier and API

```text
Read docs/context.md. Phase 1 is done. Add SQLite, the ADK classifier, the ticket protocol methods, and the HTTP routes. Do not build the ticket UI. Do not add the "Later" items.

- packages/storage: departments, tickets, and decisions, matching the v1 shape. Zod schemas live in @ticket/shared. SQLite at TICKET_DATA_DIR (default apps/agent/.data/tickets.db). Apply Drizzle migrations when the agent starts. Electron and the API never open this file. allowBuilds: better-sqlite3 false.
- In apps/agent, modules (not new packages) for the Ollama HTTP client and an ADK OllamaLlm. Follow the host rules in the context. The agent is one LlmAgent with outputSchema departmentId, confidence, rationale. Ticket text goes in the user message as untrusted data, not in the system instruction.
- Classify in code after the model returns: active department ids only, confidence >= CLASSIFY_MIN_CONFIDENCE, otherwise needs_review. Network or model errors are status failed. Persist the decision.
- Protocol methods from the context table. The HTTP routes forward to them and do not classify. API key auth except /health. /health also reports ollama reachable or unreachable and the configured model name, never a token. Same externalId returns the stored decision without a second model call. Override accepts only an active department and sets overridden.

Tests use a fake Ollama HTTP server, not the company server: valid label, unknown department, low confidence, Ollama down, missing API key, repeat externalId. Also test that sanitize removes a dummy GOOGLE_API_KEY before ADK loads; do not print the value.

Run typecheck, test, and lint. Add a curl example to the README.
```

## Prompt 3 — Electron client

```text
Read docs/context.md. Phases 1 and 2 are done. Build the v1 desktop client. Do not change the agent or the API unless a phase 2 test is failing. Do not add the "Later" items.

One Vue 3 screen, Composition API, no UI library. The main process calls the agent through @ticket/agent-client. The renderer never calls fetch, never sees the agent token, and never sees the API key.
- Agent health from system.ping.
- Create department (id, name, description).
- Submit ticket (externalId, subject, body, channel) and show status, department, confidence, and rationale as plain text.
- List the recent tickets.
- Override a ticket by picking an active department.

Keep the preload as a fixed window.api. Validate responses with @ticket/shared in the main process. Disable the submit button while a request is in flight.

Test the screen state for a labeled result and a needs_review result with no department applied. Run typecheck, test, and lint. In the summary, say how to run the agent, the API, and the desktop app together.
```
