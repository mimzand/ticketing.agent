# redrock.ticketing.agent

Windows desktop app that assigns one organization department to an incoming ticket.

The v1 decisions, the process split, the package graph, and the phased build prompts are in
[docs/context.md](docs/context.md). Read it before changing the structure.

Status: v1. The agent classifies tickets with ADK and Ollama, the API forwards those
operations, and the desktop shell (Tickets, Departments, Settings) talks to the agent over the
agent protocol.

## Requirements

- Node.js 22.12 or later
- Yarn 4 through Corepack (`corepack enable` once; the version is pinned in `package.json`)

```sh
corepack enable
yarn install
```

`yarn install` runs `@ticket/desktop`'s postinstall (`install-electron`), which downloads the
Electron binary. `.yarnrc.yml` sets `nodeLinker: node-modules` and keeps lifecycle scripts enabled.

## Development

| Command | What it does |
| --- | --- |
| `yarn agent:dev` | Starts the agent on `127.0.0.1` (random port) and writes `apps/agent/.agent-data/agent-state.json` |
| `yarn api:dev` | Starts the HTTP API on `http://127.0.0.1:8787` |
| `yarn api:up` | Starts the agent and the API together |
| `yarn dev` | Starts the desktop app. It connects to an agent that is already running; start `yarn agent:dev` first |
| `yarn typecheck` | TypeScript (strict) in every workspace |
| `yarn test` | Vitest across all workspaces |
| `yarn lint` | ESLint, including the package boundary rules |

Typical session, in two terminals:

```sh
yarn api:up     # agent + API
yarn dev        # desktop shell
```

## Desktop shell

The sidebar has three sections; the agent status is at the bottom of the sidebar.

- **Tickets** (opens first): the 50 most recent tickets with subject, status, department,
  confidence, channel, and created time. Select a row for the body, the rationale, and the
  override (active departments only). **New ticket** submits one; the button is disabled while
  the classifier runs. `needs_review` and `failed` never show a department.
- **Departments**: every department, inactive ones included. Add (id, name, description; new
  ones are active), **Edit** (name, description, active; the id never changes), and **Remove**.
  Remove is refused while any ticket decision references the id; deactivate it instead.
- **Settings**: the theme switch (dark by default, remembered in the renderer's localStorage)
  and four categories:
  - *Ollama Connection*: server URL, connection timeout, **Test connection** (tests the URL in
    the form without saving it), and the access token.
  - *AI Models*: the models the server reports, the active model, and the classify timeout.
  - *Classification*: minimum confidence (default 0.7).
  - *Storage*: database path and department and ticket counts (read only).

Non-secret settings are saved by the agent in SQLite and apply to the next classify without a
restart. `OLLAMA_HOST`, `OLLAMA_MODEL`, and `CLASSIFY_MIN_CONFIDENCE`, when set and valid, win
over the saved value and make the field read-only ("Overridden by `VAR`"); an invalid variable is
ignored and its error is shown on the field.

The access token is never stored in SQLite, never sent to the renderer, and never accepted by the
HTTP API. Electron main encrypts it with `safeStorage` (`ollama-token.bin` in the app's user data
folder) and hands it to the agent, which keeps it in memory and gets it again after a restart. If
the system cannot encrypt, the token is not saved. It is sent to Ollama only over https or to a
loopback address. `OLLAMA_TOKEN` in the agent's environment still works as a fallback.

```sh
curl http://127.0.0.1:8787/health
# {"ok":true,"service":"ticket-api","agent":"connected","ollama":"reachable","model":"qwen3:8b"}

curl -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d "{\"externalId\":\"ext-1\",\"subject\":\"Invoice\",\"body\":\"Please review.\",\"channel\":\"email\"}" http://127.0.0.1:8787/v1/tickets:classify
```

Departments can be edited and removed over HTTP too (the id in the path cannot change):

```sh
curl -X PATCH -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d "{\"active\":false}" http://127.0.0.1:8787/v1/departments/billing
curl -X DELETE -H "X-API-Key: $API_KEY" http://127.0.0.1:8787/v1/departments/billing   # 409 while a decision references it
```

On loopback, a missing `API_KEY` is generated and printed once when the API starts.

Environment variables: `AGENT_STATE_FILE`, `API_HOST` (default `127.0.0.1`), `API_PORT` (default
`8787`), `API_KEY`, `TICKET_DATA_DIR` (default `apps/agent/.data/tickets.db`), `OLLAMA_HOST`,
`OLLAMA_MODEL`, `OLLAMA_TOKEN`, `CLASSIFY_MIN_CONFIDENCE` (default `0.7`).

## Layout

```text
packages/shared          Zod schemas shared by every process (no Node, no Electron)
packages/agent-protocol  frames, envelopes, handshake, method registry (no Node APIs)
packages/agent-client    state-file lookup, handshake, typed requests (no Electron)
apps/agent               the agent service (no Electron)
apps/api                 Hono HTTP API, reaches the agent only through @ticket/agent-client
packages/storage         SQLite departments, tickets, decisions
packages/model-provider  Ollama HTTP client
packages/adk-runtime     ADK boundary and OllamaLlm
packages/agent-host      createAgentHost (classifier rules)
apps/desktop             Electron main, preload (window.api), Vue shell: Tickets, Departments, Settings
```
