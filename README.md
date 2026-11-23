# redrock.ticketing.agent

Windows desktop app that assigns one organization department to an incoming ticket.

The v1 decisions, the process split, the package graph, and the phased build prompts are in
[docs/context.md](docs/context.md). Read it before changing the structure.

Status: v1. The agent classifies tickets with ADK and Ollama, the API forwards those
operations, and the desktop window submits tickets over the agent protocol.

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
yarn dev        # desktop window shows the agent ping
```

```sh
curl http://127.0.0.1:8787/health
# {"ok":true,"service":"ticket-api","agent":"connected","ollama":"reachable","model":"qwen3:8b"}

curl -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d "{\"externalId\":\"ext-1\",\"subject\":\"Invoice\",\"body\":\"Please review.\",\"channel\":\"email\"}" http://127.0.0.1:8787/v1/tickets:classify
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
apps/desktop             Electron main, preload (window.api), Vue ticket screen
```
