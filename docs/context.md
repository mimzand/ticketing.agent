# Ticketing Agent — context

This repository: https://github.com/redrock-technology/redrock.ticketing.agent

Pattern source (read only): `C:\Users\zandm\Projects\Algoalliance\ai.agents\sample-agent`. Do not modify it. Do not copy its tree. Its package names are `@rka/*`; this repo uses `@ticket/*` and must not depend on `@rka/*`. Read the files named below for the shape of a boundary, then implement that shape for tickets.

Paste one prompt per fresh Claude session, after the previous phase is done. Do not redo finished work.

## Product

Windows desktop app. An operator submits a ticket; the agent assigns one organization department and stores that label. Low confidence or an unknown department stays `needs_review` for a human override.

The process split, the package graph, and the loopback protocol come from the pattern source. The domain is tickets, not research or chat. The package manager stays Yarn 4.

## What moves across

| Pattern source | This repo | What changes |
| --- | --- | --- |
| `apps/desktop` shell | `@ticket/desktop` | One ticket screen. No chat, research, or settings pages. |
| `apps/agent` service | `@ticket/agent` | Same role: sole SQLite writer, serves the protocol, no Electron. |
| `apps/api` HTTP front | `@ticket/api` | Ticket routes only. No Swagger in v1. |
| `@rka/shared` | `@ticket/shared` | Department, ticket, and decision schemas. No research DTOs. |
| `@rka/storage` | `@ticket/storage` | Three tables. No task, source, report, or ADK session tables. |
| `@rka/model-provider` | `@ticket/model-provider` | Ollama HTTP only. Tool calling stays off. |
| `@rka/adk-runtime` | `@ticket/adk-runtime` | Env sanitising, `OllamaLlm`, one classifier call. No tools, no code execution, no SQLite session service. |
| `@rka/agent-host` | `@ticket/agent-host` | `createAgentHost` wires storage, Ollama, and the classifier. No second runtime. |
| `@rka/agent-protocol` | `@ticket/agent-protocol` | Same frame and handshake rules. Protocol name `ticket-agent`, version 1. Ticket methods only. |
| `@rka/agent-client` | `@ticket/agent-client` | Same role for the shell and the API. |
| `@rka/tools`, `@rka/agent-runtime` | do not add | No web tools and no legacy engine. |
| pnpm | Yarn 4 | Corepack, `nodeLinker: node-modules`. |

## Processes

```text
Vue renderer ── window.api (Zod) ──▶ Electron main (shell)
 sandboxed, no network                  │  @ticket/agent-client
                                        │  loopback + token
                                        │  utilityProcess.fork (or attach)
                                        ▼
                                   apps/agent
                                      createAgentHost
                                      SQLite (sole writer)
                                      Ollama + ADK classifier
                                        ▲
                                   apps/api  ── @ticket/agent-client, client kind cli
                                      Hono on 127.0.0.1:8787
                                      no database, no ADK, no Electron
                                        ▲
                                   another frontend later
```

The renderer never sees the agent port, the agent token, or the API key, and it never calls `fetch`. Electron main talks to the agent, not to the HTTP API. The API is the door for other clients. Both clients use `@ticket/agent-client`.

The agent binds `127.0.0.1` only and writes a state file: protocol, version, host, port, token, pid, `startedAt`. Default path `apps/agent/.agent-data/agent-state.json`. `AGENT_STATE_FILE` overrides it. Gitignore that directory. The host field is the literal `127.0.0.1`.

The desktop starts the agent itself. Electron main reads the state file first: if it names a live pid on `127.0.0.1` whose agent answers the handshake (for example `yarn agent:dev` or `yarn api:up`), the desktop attaches to that agent and starts nothing. Otherwise main forks exactly one child with Electron's `utilityProcess` (no shell, no `child_process.exec`): the same `apps/agent` service, built to `apps/desktop/out/agent/main.js`, speaking this same protocol. The child gets no command-line arguments; its paths (`AGENT_STATE_FILE`, `TICKET_DATA_DIR`) and the parent pid go in its environment, the agent generates its own token and writes it only to the state file, and `API_KEY` is removed from the child's environment. No token or key is ever a command-line argument or shown in the window; the Ollama token reaches the agent over the loopback handoff. An agent refuses to start next to a live agent for the same state file, so there is still one SQLite writer.

On quit, main sends `system.shutdown` (desktop shell only), waits for the child to exit, and the state file is gone; an attached agent keeps running. If the child crashes, main removes the stale state file and restarts it with a short, bounded backoff (five tries, reset after 30 s of uptime) while the sidebar shows "Reconnecting…". A child started by the desktop watches the parent pid and stops when the app is killed outright.

A classify is cancellable end to end: the shell aborts its request, the client sends `system.cancel`, the agent aborts the ADK run and the Ollama HTTP request, and no decision is stored. A ticket row without a decision (a cancel, or a crash mid-classify) does not hold its `externalId`: the next submit classifies it. A stored decision is returned without another model call, and a late cancel does not undo it.

## Packages

```text
@ticket/shared
    ▲
@ticket/model-provider     @ticket/storage     @ticket/agent-protocol
    ▲                            ▲                      ▲
    └──────── @ticket/adk-runtime                       │
                   ▲                                    │
                   └──── @ticket/agent-host ────────────┘
                              ▲
                         apps/agent
                              ▲
              @ticket/agent-client (desktop main, apps/api)
```

- Each package has one entry, `exports["."]`, pointing at `src/index.ts`. Deep imports are rejected by ESLint.
- `@ticket/shared` has no Node, no Electron, and no other workspace packages.
- `@ticket/model-provider` and `@ticket/storage` depend only on `@ticket/shared`.
- `@ticket/agent-protocol` depends only on `@ticket/shared` and uses no Node APIs. Frames are a 4-byte big-endian length plus UTF-8 JSON, as in `packages/agent-protocol/src/framing.ts`.
- `@ticket/adk-runtime` may depend on `@ticket/shared` and `@ticket/model-provider`. It does not depend on storage, the protocol, or the host. `@google/adk` is imported only inside this package, and only after the environment is sanitised.
- `@ticket/agent-host` is the only package that composes storage, the model provider, and the ADK runtime. It does not import `electron`. `createAgentHost` is the composition root. New classifier wiring goes here, not in `apps/agent` route code and not in Electron main.
- `@ticket/agent-client` depends on the protocol. It never imports `electron`. The renderer and the preload never import it or the protocol.
- `apps/agent` calls `createAgentHost` and serves the protocol. It never imports `electron`.
- `apps/api` depends on `@ticket/shared` and `@ticket/agent-client` only. It never opens SQLite and never imports `@google/adk`.
- `apps/desktop` main may use `@ticket/agent-client`. Its preload and renderer may use `@ticket/shared` only. Only `apps/desktop` may import `electron`.
- Enforce these boundaries with ESLint `no-restricted-imports`.

There is no `HostPorts` reverse call in v1. The pattern source uses reverse calls for dialogs, `openExternal`, and `safeStorage`. This product does not ask the shell for those.

## Protocol methods

The first message on a connection is `system.hello` (protocol name, version, token, client kind `shell`, `cli`, or `test`). Any other first message closes the connection. The token is at least 32 random bytes, base64url, compared in constant time. A client that does not finish the handshake in 5 seconds is disconnected. After hello:

| Method | Purpose |
| --- | --- |
| `system.ping` | liveness: pid, version, protocol version |
| `model.health` | whether Ollama is reachable, and the configured model name |
| `departments.list` | every department |
| `departments.create` | `id`, `name`, `description` |
| `tickets.classify` | store the ticket and return the decision; the same `externalId` returns the stored decision |
| `tickets.list` | the 50 most recent tickets |
| `tickets.override` | an active department only; status becomes `overridden` |

Every request and response is validated with Zod. Ticket text is untrusted data in the user message, not in the system instruction.

## Classifier

Departments: `id`, `name`, `description`, `active`.

Tickets: `id`, unique `externalId`, `subject`, `body`, `channel`, `createdAt`.

Decision: `departmentId` or null, `confidence` (0–1), `rationale`, `status` (`labeled` | `needs_review` | `overridden` | `failed`). Threshold `CLASSIFY_MIN_CONFIDENCE`, default `0.7`. An unknown department or low confidence becomes `needs_review` with no applied label.

SQLite file: `TICKET_DATA_DIR` (default `apps/agent/.data/tickets.db`). `@ticket/storage` applies Drizzle migrations when the agent opens the database. Gitignore `.data`. Electron and the API never open this file.

`createAgentHost` builds one `LlmAgent`. Its `outputSchema` is `departmentId`, `confidence`, `rationale`. After the model returns, code in the host accepts only an active department id and a confidence at or above the threshold. Otherwise the status is `needs_review` and no label is applied. Network or model errors are status `failed`. The decision is persisted. The same `externalId` does not call the model again.

Model: company Ollama only (`OLLAMA_HOST`, `OLLAMA_MODEL`). Construct `new OllamaLlm(...)` from `@ticket/adk-runtime`, backed by `@ticket/model-provider`. No Gemini model name, no OpenAI, no cloud LLM, no web search.

Before importing `@google/adk`, strip the names listed in `packages/adk-runtime/src/env.ts` (`TELEMETRY_ENV_VARS`, `CLOUD_ENV_VARS`, and `ADK_FEATURE_FLAG_PATTERN`). Set `OTEL_SDK_DISABLED=true` and `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`.

Ollama HTTP follows `packages/model-provider/src/ollama/provider.ts`: `http:` or `https:` only, no userinfo, query, or fragment, `redirect: 'manual'`, bearer token only for HTTPS or loopback, `AbortSignal`, timeouts. Do not install `dockerode`.

## HTTP API

Hono on `127.0.0.1:8787` (`API_HOST`, `API_PORT`). Each route forwards to the method above. The API does not classify.

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health`, `/docs`, `/openapi.json` | public |
| `GET` `POST` | `/v1/departments` | API key |
| `PATCH` `DELETE` | `/v1/departments/{id}` | API key |
| `POST` | `/v1/tickets:classify` | API key |
| `GET` | `/v1/tickets` | API key |
| `POST` | `/v1/tickets/{id}/override` | API key |

`X-API-Key` or `Authorization: Bearer`, compared in constant time on a digest, as in `apps/api/src/security.ts`. On loopback, generate a key for the API process when `API_KEY` is unset and print it once. Responses never include the agent token or the Ollama token.

`GET /health` returns `{ "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable", "ollama": "reachable" | "unreachable", "model": "<name, or empty>" }`. The API learns that the agent is up by `system.ping`, then asks `model.health`. `model` is empty when the agent cannot be asked.

`GET /openapi.json` is OpenAPI 3.1 generated from the same Zod schemas the routes parse. `GET /docs` is Swagger UI served from `swagger-ui-dist` (no CDN). Both are public. The page does not store the API key.

## Desktop shell

Electron, Vue 3, TypeScript, Vite. Window flags, as in `apps/desktop/src/main/window.ts`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. The preload exposes a fixed `window.api`. Ticket text is plain text.

The main process reads `AGENT_STATE_FILE`, connects with `@ticket/agent-client` as client kind `shell`, and validates payloads with `@ticket/shared`. The screen shows agent health, creates a department, submits a ticket, lists recent tickets, and overrides a department. The submit control is disabled while a request is in flight.

## Tooling

- Yarn 4 workspaces, Corepack, `nodeLinker: node-modules` in `.yarnrc.yml`. Workspaces are `apps/*` and `packages/*`. Node 22.12+. No pnpm. Do not copy `pnpm-workspace.yaml`.
- Electron's postinstall must run, because it downloads the Electron binary. From phase 2, set `better-sqlite3` `dependenciesMeta.built` to `false` so Yarn keeps the prebuilt binary and does not compile it.
- TypeScript strict, ESM, Vitest, ESLint.

## Patterns, not files to copy

- `apps/desktop/src/main/window.ts` and `apps/desktop/src/main/security.ts` — window isolation.
- `apps/desktop/src/preload/index.ts` — a fixed `window.api`.
- `apps/agent/src/server.ts` and `apps/agent/src/state-file.ts` — loopback server and state file.
- `apps/api/src/security.ts` and `apps/api/src/agent-link.ts` — API key, and one lazy client connection.
- `packages/agent-protocol/src/handshake.ts`, `envelope.ts`, `framing.ts` — hello, token, frames.
- `packages/agent-client/src/connect.ts` — read the state file, handshake, typed requests.
- `packages/adk-runtime/src/env.ts` and `packages/adk-runtime/src/ollama/ollama-llm.ts` — sanitise, then `OllamaLlm`.
- `packages/model-provider/src/ollama/provider.ts` — host, redirect, and token rules.
- `packages/storage/src/schema.ts` — migration shape only, not the research tables.
- `packages/agent-host/src/agent-host.ts` — one composition function. Do not port chat or research.

## Out of v1

Research, chat, a tools package, the legacy runtime, an engine flag, an in-process agent mode, reverse calls into the shell, code execution, `dockerode`, rate limits, CORS lists, pagination, idempotency-key conflicts, a second UI package. Do not build these unless a prompt asks for them. OpenAPI/Swagger, `safeStorage` for the Ollama token, and the Electron utility-process supervisor are in.

## Later

Evidence quotes, department examples and aliases, taxonomy versions, rate limit, CORS.

---

## Prompt 1 — Scaffold the structure

```text
Read docs/context.md, including "What moves across", "Processes", and "Packages". Implement only that skeleton. Stop before SQLite, ADK, Ollama, model-provider, storage, agent-host, and the ticket UI.

Yarn 4 workspace (Corepack, nodeLinker: node-modules) with @ticket/shared, @ticket/agent-protocol, @ticket/agent-client, @ticket/agent, @ticket/api, and @ticket/desktop. One entry point per package. ESLint rejects a deep import and a boundary break from the context.
- Protocol name ticket-agent, version 1. Frames are a 4-byte big-endian length plus UTF-8 JSON. system.hello then system.ping. Reject any other first message and a wrong token. Compare the token in constant time. The state file names 127.0.0.1 only. Handshake timeout is 5 seconds.
- Agent: listen on 127.0.0.1, write the state file, serve hello and ping. No Electron.
- API: GET /health returns { "ok": true, "service": "ticket-api", "agent": "connected" | "unavailable" }, validated by Zod in @ticket/shared. The API reaches the agent only through @ticket/agent-client.
- Desktop: one window that shows the agent ping. Preload exposes only getHealth. Main reads AGENT_STATE_FILE and uses @ticket/agent-client. The renderer has no Node and no network. The desktop does not call the HTTP API.
- Root scripts: agent:dev, api:dev, api:up (agent and api together), dev for the desktop, typecheck, test, lint.
- .yarnrc.yml: nodeLinker node-modules. Electron's postinstall must be allowed to run.
- Tests: /health matches the schema when the agent is up and when it is down; a bad token is rejected; the state-file host is only 127.0.0.1; BrowserWindow uses the four isolation flags from the context.
- README: Node 22.12+, Yarn 4, and the dev commands (yarn). Point at this file.

Do not copy the sample-agent tree. Do not add the packages that phase 2 introduces. Run typecheck, test, and lint.
```

## Prompt 2 — Storage, ADK, and the API

```text
Read docs/context.md. Phase 1 is done. Add @ticket/storage, @ticket/model-provider, @ticket/adk-runtime, and @ticket/agent-host, then the ticket methods and the HTTP routes. Follow the package graph. Do not build the ticket UI. Do not add the "Out of v1" items.

- storage: departments, tickets, and decisions, matching the context. Zod schemas live in @ticket/shared. SQLite at TICKET_DATA_DIR (default apps/agent/.data/tickets.db). Apply Drizzle migrations when the agent opens it. Set better-sqlite3 dependenciesMeta.built to false. Only the agent process opens the file.
- model-provider: the Ollama HTTP client, with the host rules in the context. No tool calling.
- adk-runtime: sanitise the environment, then OllamaLlm. @google/adk is imported only here. No session tables, no tools, no dockerode.
- agent-host: createAgentHost wires those three. One LlmAgent, outputSchema departmentId, confidence, rationale. Ticket text is untrusted user data. Classify in code after the model returns. Persist the decision. The same externalId does not call the model again.
- apps/agent calls createAgentHost and serves the protocol methods from the context. The HTTP routes forward to them and do not classify. API key auth except /health. /health also reports ollama reachable or unreachable and the configured model name, never a token. Override accepts only an active department and sets overridden.

Tests use a fake Ollama HTTP server, not the company server: valid label, unknown department, low confidence, Ollama down, missing API key, repeat externalId. Also test that sanitize removes a dummy GOOGLE_API_KEY before ADK loads; do not print the value.

Run typecheck, test, and lint. Add a curl example to the README.
```

## Prompt 3 — Electron client

```text
Read docs/context.md. Phases 1 and 2 are done. Build the v1 desktop client on the existing shell. Do not change the agent or the API unless a phase 2 test is failing. Do not add the "Out of v1" items.

One Vue 3 screen, Composition API, no UI library. The main process calls the agent through @ticket/agent-client. The renderer never calls fetch, never sees the agent token, and never sees the API key.
- Agent health from system.ping.
- Create department (id, name, description).
- Submit ticket (externalId, subject, body, channel) and show status, department, confidence, and rationale as plain text.
- List the recent tickets.
- Override a ticket by picking an active department.

Keep the preload as a fixed window.api. Validate responses with @ticket/shared in the main process. Disable the submit button while a request is in flight.

Test the screen state for a labeled result and a needs_review result with no department applied. Run typecheck, test, and lint. In the summary, say how to run the agent, the API, and the desktop app together.
```
