# AI Agents Architecture Report — redrock.ticketing.agent

**Product status:** v1 (+ P0 eval / override feedback)  
**Sources:** `docs/context.md`, `docs/eval.md`, `packages/adk-runtime`, `packages/agent-host`, `packages/storage`, `packages/eval`, `apps/`*  
**Reviewed:** 2026-11-23  
**Last updated:** 2026-11-23 (P0 implementation review)

---

## Executive summary

This repository is not a chat agent or a multi-agent platform. It is a **single-shot department classifier**:

- One ADK `LlmAgent` call to **Ollama**
- Persistence in **SQLite**
- Narrow **sender memory** (at most 5 prior tickets, email-keyed only)
- **Human-in-the-loop** via `needs_review` and operator override
- **Golden eval** (`@ticket/eval`, `yarn eval`) and a **read-only override feedback** export that becomes eval cases and operator-approved few-shot candidates (no auto fine-tune)

The central design bet is **deterministic host rules** over agentic tools, RAG, or multi-step reasoning.

> From `docs/context.md`: “The domain is tickets, not research or chat.”  
> Tool calling, an ADK session database, and multi-agent orchestration are explicitly out of v1.

---

## 1. Overall architecture

### Process topology

```text
Vue renderer (sandboxed) ── window.api (Zod) ──▶ Electron main (@ticket/agent-client, kind=shell)
                                                      │
                                                      ▼ loopback TCP + token
                                               apps/agent (sole SQLite writer)
                                               createAgentHost → classify
                                                      ▲
                               apps/api (Hono :8787, @ticket/agent-client, kind=cli)
                                                      ▲
                               @ticket/eval (dev only) ── createAgentHost + fake Ollama
```

- The renderer never sees the agent port, agent token, or API key, and never calls `fetch`.
- Electron main talks to the agent, not to the HTTP API.
- The API is the door for other clients; it opens no database and does not import ADK.
- `@ticket/eval` is a **dev tool**: it may use the host, storage (temp DB), and shared; nothing imports it; it never imports ADK, the protocol, or apps.

### Package graph

| Package | Role |
| --- | --- |
| `@ticket/shared` | Zod schemas — no Node, no Electron |
| `@ticket/agent-protocol` | Frames, envelopes, handshake, method registry |
| `@ticket/agent-client` | State-file lookup, handshake, typed requests |
| `@ticket/storage` | SQLite + Drizzle (only the agent opens the file) |
| `@ticket/model-provider` | Ollama HTTP client |
| `@ticket/adk-runtime` | Sole importer of `@google/adk` |
| `@ticket/agent-host` | Composition root: `createAgentHost` |
| `@ticket/eval` | Golden suites + override-feedback tooling (dev only) |
| `apps/agent` | Protocol server on `127.0.0.1` |
| `apps/api` | HTTP facade (no DB, no ADK) |
| `apps/desktop` | Electron + Vue UI |

Import boundaries are enforced by ESLint (`no-restricted-imports`) and `test/boundaries.test.ts`.

---

## 2. Classify flow

| Step | What happens | Key files |
| --- | --- | --- |
| 1. Input | `externalId`, `subject`, `body`, `channel`, optional `email` | `packages/shared/src/ticket.ts` |
| 2. Idempotency | Same `externalId` → stored decision, no second model call | `packages/agent-host/src/host.ts` |
| 3. Sender memory | If email present: up to 5 prior decided tickets | `packages/storage/src/open.ts` |
| 4. Classify | One `LlmAgent` → JSON: `departmentId`, `confidence`, `rationale`, `quote`, `categoryId`, `priority`; system instruction = departments + active categories (default priority, examples) + admin priority trend lines | `packages/adk-runtime/src/classify.ts` |
| 4b. Fallback | At most one more attempt with `fallbackModel`, only after a typed retryable failure, within the same timeout budget | `packages/agent-host/src/host.ts`, `decision-event.ts` |
| 5. Host rules | Active department id + confidence threshold, else `needs_review`; quote only if exact substring; category only an active id, priority only `low`/`normal`/`high`/`urgent`, else null (independent of the department) | `acceptQuote` in shared + host |
| 6. Persist | Ticket + decision (department fields, category, priority, review flags) + `taxonomyVersion` | `packages/storage/src/schema.ts` |
| 6b. Decision log | One secret-free `Decision {…}` JSON line per stored outcome (ids, counts, codes) | `onDecisionEvent` → `apps/agent/src/run.ts` |
| 7. HITL | Review queue (`needs_review` + `failed`, oldest first); department override → `overridden`; admin category/priority corrections keep the model value once | `tickets.reviewQueue`, `tickets.override`, `tickets.setCategory`, `tickets.setPriority` |
| 8. Feedback (read-only) | Department override export, and a separate category/priority review export, for eval / few-shot review | `tickets.overrideFeedback`, `tickets.decisionFeedback` |

Decision statuses: `labeled` | `needs_review` | `overridden` | `failed`.

Cancel: `system.cancel` aborts the Ollama request; an undecided row does not keep the `externalId`, so the same id can be submitted again.

---

## 3. AI agent concept matrix

### Coverage snapshot

| Category | Approx. count |
| --- | ---: |
| Present / strong | 10 |
| Partial / narrow | 4 |
| Absent / deliberate | 5+ |

### Concept-by-concept

| Concept | Status | How this project implements it |
| --- | --- | --- |
| **Memory** | Partial | Sender memory (≤5 tickets by email); no chat history; throwaway ADK `InMemorySessionService` |
| **Context management** | Present | System = department and category catalogues + admin priority trend lines (counts only); user = ticket + untrusted same-sender history; `taxonomyVersion` on each decision |
| **RAG / embeddings** | Absent | None — only department examples in the prompt and SQL `priorTickets` |
| **Multi-agent** | Absent | One `LlmAgent`; `disallowTransferToParent/Peers: true`; supervisor is Electron process restart only |
| **Evaluation** | Present | `@ticket/eval`: golden JSON suites (golden / override / feedback sources), fake in-process Ollama, department precision/recall plus separate category and priority scores, recorded live replies for synthetic tickets, CI via Vitest; no live dashboard |
| **Tools / function calling** | Absent | Explicitly off — plain JSON output from Ollama |
| **Planning / CoT / ReAct** | Absent | Single shot; Ollama `think: false`; no reasoning loop |
| **Guardrails / safety** | Present | Prompt split, host validation, redaction, rate limit, CORS, OTEL disabled |
| **LLM provider** | Present | Company Ollama only (default `qwen3:8b`), optional fallback model tried once after a retryable failure; no cloud routing |
| **Prompt engineering** | Present | `buildClassifierInstruction` + `outputSchema` + instruction as a function |
| **State / workflow** | Partial | Four decision statuses and a deterministic review queue — not a workflow engine |
| **Observability** | Present | One structured, secret-free decision event per stored classify (status, ids, counts, attempts, failure code); OTEL deliberately disabled; no traces or message content |
| **Human-in-the-loop** | Present | Review queue for `needs_review` / `failed`; department override; admin category and priority corrections; `replacedDepartment` in later sender context; admin priority trends in the instruction; exports for human-approved few-shots |
| **Session management** | Partial | TCP protocol sessions + idempotency; no durable ADK chat session |
| **Explainability** | Present | Rationale + evidence quote verified as exact substring (≤240 characters) |
| **Taxonomy versioning** | Present | Immutable catalogue snapshots on every department change; eval reports taxonomy version + catalogue hash |
| **Identity / sender** | Present | Normalized email only; operator merge; model never decides two people are one |
| **Override feedback loop** | Present | Read-only exports (department overrides; category/priority reviews) → eval cases + few-shot candidates; catalogue edits stay manual |
| **Resilience** | Partial | One bounded fallback-model attempt on typed retryable failures; no retry loop, no cloud failover |

---

## 4. Why this design? (rationale for what is used)

### 4.1 Sender memory (not conversation memory)

Repeat senders often share a department pattern. At most five summary rows (no body/rationale) go in the **user message** so the model gets context without building a chat transcript or model-decided identity.

**Why the limit:** privacy, context size, and the rule that the model never merges people — only an explicit email field or operator `senders.merge`.

Keys: `SENDER_HISTORY_LIMIT = 5` in `packages/shared/src/ticket.ts`; prompt block in `packages/adk-runtime/src/classify.ts`.

### 4.2 System / user split (context)

- Department catalogue (id, name, description, aliases, examples) lives only in the **system instruction**
- Ticket text and sender history live in the **user message**, labelled as *untrusted data*

Goal: stop prompt injection from rewriting rules or the catalogue.

The instruction is passed as a **function** so ADK does not treat `{…}` in operator text as state placeholders.

### 4.3 Post-model validation in the host (guardrails)

The model proposes; the **host decides**:

- `departmentId` must be an exact active id (not an alias or name)
- `confidence` ≥ `CLASSIFY_MIN_CONFIDENCE` (default `0.7`)
- `quote` must be an exact substring of subject or body; otherwise `null` — the model is not asked again
- `categoryId` must be an exact active category id, else `null`; `priority` must be one of `low`, `normal`, `high`, `urgent`, else `null`. Neither is coerced, a category default never fills a missing priority, and neither changes the department outcome
- A fallback answer passes through exactly the same rules; two answers are never merged

Philosophy: trustworthy explainability beats a hallucinated quote.

### 4.4 Human-in-the-loop and soft learning

When the model is unsure, no label is applied (`needs_review`). An operator override:

- Sets status to `overridden`
- On the first override, records `replacedDepartmentId` for later classifies of the same sender

Operator corrections are described as stronger context than a model label — without fine-tuning.

The same `replacedDepartmentId` rows also feed a **read-only feedback export** so humans can promote failure cases into the golden suite and copy few-shot examples into department `examples` (see §4.8).

### 4.5 ADK boundary without cloud / session DB

Only the agent + Runner abstraction is needed. Before import:

- Google/cloud/OTEL env vars are stripped (`packages/adk-runtime/src/env.ts`)
- `OTEL_SDK_DISABLED=true`
- `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`
- Ephemeral `InMemorySessionService`
- Tools and code execution stay off

Goal: keep attack surface and cloud dependency near zero.

### 4.6 Composition root and package boundaries

All classifier rules live in `createAgentHost`. The API and Electron do not classify. That split simplifies maintenance, testing, and architectural security. Eval drives the same host with a fake Ollama and never becomes a runtime dependency of the apps.

### 4.7 Taxonomy versioning

Every department / aliases / examples change increments a monotonic version and stores a snapshot. Each decision binds to the catalogue version used at classify time. History has no rollback and old decisions are never rewritten — enabling audit and drift comparison. The eval report prints taxonomy version and a short SHA-256 of each suite catalogue.

### 4.8 Golden eval and override feedback (P0 — implemented)

**Why:** Without a fixed suite, changing the model, prompt, or taxonomy is a silent risk. Without a path from overrides into review material, operator corrections stay trapped in SQLite.

**What shipped:**

| Piece | Behavior |
| --- | --- |
| `@ticket/eval` | Runs real `createAgentHost` + temp SQLite against an in-process fake Ollama (no socket, no company server) |
| Golden suites | `packages/eval/golden/*.json` — scripted / recorded / error replies; `source: golden \| override` |
| `yarn eval` | Prints accuracy, per-department precision/recall, mismatch counts, catalogue hashes; exit 1 on failure; also covered by `yarn test` |
| Override export | `tickets.overrideFeedback` / `GET /v1/tickets:override-feedback` — up to 500 rows where both `replacedDepartmentId` and operator `departmentId` are set; **no email** |
| Feedback CLI | `yarn workspace @ticket/eval run feedback <export.json>` → `override-cases.json` + `few-shot-candidates.json` (`approval: "operator"`) |

**What stays human:** no automatic fine-tune, no automatic catalogue writes, no desktop export UI (API/curl only). Checked-in goldens use synthetic text; real export output should be rewritten synthetic before landing in `golden/`.

Operator runbook: [`docs/eval.md`](eval.md).

### 4.9 Review queue, category/priority feedback, recording, decision log, fallback (implemented)

| Capability | Behavior | Why this shape |
| --- | --- | --- |
| Human review queue | `tickets.reviewQueue` / `GET /v1/tickets:review-queue`: `needs_review` + `failed`, oldest first (id tie-break), at most 200, full counts from one SQL query; a department override resolves a ticket, a category/priority change does not; repeating the same `externalId` returns the stored decision and does not re-classify; desktop "Review queue" view reuses the ticket detail | A deterministic workflow, not another agent: the department status already says what needs a person |
| Category/priority feedback | `tickets.decisionFeedback` / `GET /v1/tickets:decision-feedback`: rows with `categoryReviewed` or `priorityReviewed` (confirmations and null model values count), `modelCategoryId`/`modelPriority` vs final values, no email, ≤500 newest first; `yarn workspace @ticket/eval run decision-feedback` → `source: "feedback"` cases (only reviewed fields judged; `wrongReply` only when the admin changed something) + category few-shot candidates | Review flags, not replaced values, define "reviewed"; priority learns from aggregate trends, so no priority few-shots |
| Recorded replies | `yarn workspace @ticket/eval run record <in> <out> --synthetic`: real `createAgentHost` + instruction + ADK against the company Ollama in a temp DB; raw answer captured by the `onModelReply` hook; human expectation never replaced; email refused; never writes into `golden/` | Measures the live model with the production prompt, without duplicating it in eval |
| Decision log | `onDecisionEvent` → `Decision {…}` line in the agent log: status, department/category/priority ids, confidence, taxonomy version, history count, quote accepted, duration, attempts, model role, fixed failure code | Debug drift and failures without ticket text, email, rationale, quote, model output, token, or URL |
| Fallback model | Optional `fallbackModel` / `OLLAMA_FALLBACK_MODEL`; max 2 attempts; retry only on network, HTTP 500/502/503/504, invalid/empty response, malformed JSON, schema mismatch; never on timeout, cancel, 4xx, redirect, invalid URL, or host-rule outcomes; same total timeout and abort signal; same host rules; never equal to the primary | Removes a single point of failure for transient faults while keeping one bounded, auditable path |

---

## 5. Storage related to the agent

SQLite at `TICKET_DATA_DIR` (default `apps/agent/.data/tickets.db`).

| Table | Role |
| --- | --- |
| `departments` | id, name, description, active, aliases, examples |
| `categories` | id, name, description, default_priority, active, examples (admin-defined problem categories) |
| `senders` | Identity keyed by normalized email |
| `tickets` | Unique `externalId`, subject, body, channel, senderId |
| `decisions` | 1:1 with ticket; department, confidence, rationale, status, quote, taxonomyVersion, replacedDepartmentId, category_id, replaced_category_id, category_reviewed, priority, replaced_priority, priority_reviewed |
| `taxonomy_versions` | Immutable catalogue snapshots |
| `settings` | Non-secret config (Ollama URL, model, fallback model, timeouts, threshold) |

**Review queue query:** counts grouped by status plus the oldest 200 rows with status `needs_review` or `failed`, in SQL.

**Decision feedback query:** rows with `category_reviewed` or `priority_reviewed` set, newest first.

**Override feedback query:** rows where `replacedDepartmentId` and `departmentId` are both non-null (first override of a classifier-applied label). Overrides from `needs_review` / `failed` (no prior department) are **not** in this export.

**Not stored:** conversation turns, ADK sessions, embeddings, raw LLM traces, email addresses in logs.

Agent runtime state (not SQLite): `apps/agent/.agent-data/agent-state.json` — host, port, token, pid.

---

## 6. Gaps vs a fuller ticketing agent

Many of these are deliberate **Out of v1** items in `docs/context.md`. Adding them should be a new product phase/prompt, not silent scope drift.

| Gap | Practical impact | Severity for current product |
| --- | --- | --- |
| RAG over internal SOPs / KB | Cannot ground on runbooks beyond department examples | Medium |
| Semantic similar-ticket retrieval | Same-sender only; no org-wide semantic neighbors | Medium |
| Live-model eval at scale | Recording is one synthetic case per run; no batch re-recording or model comparison report | Low–Medium |
| Eval baselines / dashboard | CLI + CI only; no stored historical baselines or UI | Low–Medium |
| Tools (CRM lookup, etc.) | Classify-only; no external actions | Low* |
| Multi-agent triage | Unnecessary for a single label; adds complexity | Low* |
| Log shipping / dashboards | Decision events are local log lines; no aggregation UI | Low–Medium |
| Model fallback beyond one attempt | A second model only; no stricter-prompt retry, no health-based routing | Low |
| Auto-promote few-shots / goldens | Feedback files require manual review and copy into Departments / `golden/` | Low (by design) |
| Override export for `needs_review` / `failed` | Those overrides never set `replacedDepartmentId`, so they skip the feedback pipeline | Low–Medium |

 Low for the current scope (one department label). Priority rises if the product expands into actions or chat.

### Implemented (was P0)

| Item | Status |
| --- | --- |
| Golden eval suite (`yarn eval`, precision/recall, taxonomy hash) | **Done** — see `docs/eval.md` |
| Override feedback → failure cases + few-shot candidates | **Done** — export + CLI; human approval only |
| Problem categories + AI priority with admin trends | **Done** — host-validated, independent of the department |
| Human review queue | **Done** — protocol, API, desktop view |
| Category/priority feedback export + eval pipeline | **Done** — `decision-feedback` CLI |
| Recorded-reply golden workflow | **Done** — `record --synthetic` CLI |
| Structured decision logging | **Done** — `Decision {…}` agent log line |
| One bounded fallback-model attempt | **Done** — typed retryable failures only |

Verified locally: `yarn eval` → 31 cases (24 golden, 2 override, 5 feedback), 0 failed.

---

## 7. Improvement recommendations (prioritized)

| Priority | Recommendation | Why | Risk / note |
| --- | --- | --- | --- |
| **P1** | Batch re-recording + model comparison | Re-record the synthetic golden set against a candidate model and compare scores before switching | Synthetic tickets only; never auto-edit expectations |
| **P1** | Decision-event summaries | Count events by status, failure code, and attempts over a window | Local only; keep the event contract secret-free |
| **P2** | Semantic similar-ticket retrieval | Top-k similar decided tickets org-wide (not only same sender) | Needs embedding index + explicit privacy review |
| **P2** | RAG over department SOPs | Markdown/PDF chunks; inject cited snippets into system context | Never put ticket text in the system instruction; citations must be auditable |
| **P2** | Feedback for unlabeled→override | Extend export/eval for overrides that started as `needs_review` / `failed` | Schema change or parallel export; do not weaken `replacedDepartmentId` semantics |
| **P3** | Narrow lookup tool | Only if the product moves beyond routing (e.g. CRM) | Conflicts with v1 tools-off unless a new phase; keep host validation |
| **P3** | Workflow outside ADK | If SLA/escalation is needed: state machine in storage/API; classify stays one step | Avoid turning the classifier into a multi-agent engine |
| **P3** | Desktop “Export override feedback” | Convenience over curl | Optional; API already exists |

### Keep what is already strong

1. **Trust boundary:** Ticket in the user message, catalogue in the system instruction, post-model validation, verified quotes.
2. **Process boundary:** One SQLite writer, loopback protocol, API without ADK, renderer without network, eval outside the runtime graph.
3. **Taxonomy audit:** Every decision is bound to a catalogue version; eval reports version + hash.
4. **Real HITL:** `needs_review` without a fake label; overrides show up in later sender memory and in the feedback export.
5. **Measurable classifier:** Golden + CI exit non-zero on regression.

---

## 8. Strategic takeaway

**P0 and the first P1 items are implemented**: eval, override and category/priority feedback, recorded live replies, a human review queue, structured decision logging, and one bounded fallback attempt. The highest-ROI next work is **re-recording the synthetic set against candidate models** and **summarizing decision events** — still without multi-agent or chain-of-thought.

Optional RAG and similar-ticket retrieval should stay phased and aligned with `docs/context.md` / `docs/eval.md`.

The current architecture remains a **bounded, security-conscious, auditable classifier**, now with a regression harness.

---

## 9. Key file index

| Area | Path |
| --- | --- |
| Product spec | `docs/context.md` |
| Eval / override feedback runbook | `docs/eval.md` |
| Classifier / prompts | `packages/adk-runtime/src/classify.ts` |
| ADK + Ollama bridge | `packages/adk-runtime/src/ollama-llm.ts`, `env.ts` |
| Business rules | `packages/agent-host/src/host.ts` |
| Schemas | `packages/shared/src/ticket.ts`, `packages/shared/src/feedback.ts` |
| DB | `packages/storage/src/schema.ts`, `open.ts` (`overrideFeedback`) |
| Golden suites | `packages/eval/golden/` |
| Eval package | `packages/eval/src/` (`cli.ts`, `run.ts`, `metrics.ts`, `feedback.ts`) |
| Protocol | `packages/agent-protocol/src/methods.ts`, `apps/agent/src/server.ts` |
| HTTP API | `apps/api/src/routes.ts`, `app.ts` (`GET /v1/tickets:override-feedback`) |
| Ollama client | `packages/model-provider/src/ollama.ts` |
| Redaction tests | `test/redaction.test.ts` |

---

## 10. Design quotes from `docs/context.md`

> Ticket text is untrusted data in the user message, not in the system instruction.

> No email means an unknown sender and no memory. An address is never read from the subject or the body, and the model never decides that two tickets are the same person.

> An operator correction is stronger context than a model label, but neither value … is an answer for the new ticket.

> Tool calling stays off. … No tools, no code execution, no SQLite session service.

> `yarn eval` runs the golden suite in `packages/eval/golden` through `createAgentHost` with a fake Ollama and exits non-zero on any failed case. Override feedback becomes eval cases and operator-approved few-shot candidates as files only; no automatic fine-tune and no automatic catalogue edit.

> Research, chat, a tools package … an ADK session database, model-decided identity … Do not build these unless a prompt asks for them.
