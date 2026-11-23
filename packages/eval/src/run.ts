import { createAgentHost } from '@ticket/agent-host';
import { type DecisionStatus } from '@ticket/shared';
import { openTicketDatabase } from '@ticket/storage';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeOllama, FAKE_OLLAMA_BASE_URL, FAKE_OLLAMA_MODEL } from './fake-ollama.js';
import {
  type CatalogueDepartment,
  type EvalCase,
  type Expectation,
  type ModelReply,
  type SuiteFile,
} from './suite.js';

/** What one classify produced, reduced to what the suite judges. */
export interface Outcome {
  readonly status: DecisionStatus;
  /** The department actually applied: the stored id only when the status is `labeled`. */
  readonly departmentId: string | null;
  readonly confidence: number;
  readonly quote: string | null;
  readonly taxonomyVersion: number;
}

export interface CaseResult {
  readonly suite: string;
  readonly id: string;
  readonly source: EvalCase['source'];
  readonly catalogue: string;
  readonly expected: Expectation;
  readonly actual: Outcome | null;
  readonly passed: boolean;
  /** Short reasons, no ticket text. Empty when passed. */
  readonly problems: readonly string[];
}

export interface CatalogueInfo {
  readonly suite: string;
  readonly name: string;
  /** First 12 hex of sha256 over the catalogue as the case file defines it. */
  readonly hash: string;
  /** The taxonomy version the host stored on the decisions of this catalogue. */
  readonly taxonomyVersion: number | null;
}

export interface SuiteRun {
  readonly suite: string;
  readonly threshold: number;
  readonly results: readonly CaseResult[];
  readonly catalogues: readonly CatalogueInfo[];
}

export function catalogueHash(departments: readonly CatalogueDepartment[]): string {
  const canonical = [...departments]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((d) => [d.id, d.name, d.description, d.active, d.aliases, d.examples]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

/** Problems of an outcome against an expectation. Empty when it holds. */
export function judge(expected: Expectation, actual: Outcome, threshold: number): string[] {
  const problems: string[] = [];
  if (actual.status !== expected.status) problems.push(`status ${actual.status}, expected ${expected.status}`);
  if (actual.departmentId !== expected.departmentId) {
    problems.push(`department ${actual.departmentId ?? 'none'}, expected ${expected.departmentId ?? 'none'}`);
  }
  if (expected.confidence) {
    const band = actual.confidence >= threshold ? 'above' : 'below';
    if (band !== expected.confidence) {
      problems.push(`confidence ${actual.confidence} is ${band} ${threshold}, expected ${expected.confidence}`);
    }
  }
  if (expected.quote !== undefined && actual.quote !== expected.quote) {
    problems.push(actual.quote === null ? 'quote dropped, expected one' : 'quote differs from expected');
  }
  return problems;
}

/**
 * One case through the real host: a fresh SQLite file in a temp folder, the catalogue
 * created through `createAgentHost`, the history classified (and overridden) first, then
 * the ticket. The temp folder is removed afterwards.
 */
async function classifyCase(
  file: SuiteFile,
  evalCase: EvalCase,
  reply: ModelReply,
): Promise<{ outcome: Outcome; problems: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-eval-'));
  const db = openTicketDatabase(join(dir, 'tickets.db'));
  try {
    const fake = createFakeOllama([...evalCase.history.map((entry) => entry.reply), reply]);
    const host = createAgentHost({
      db,
      // Only these variables: no token and nothing else from the caller's environment.
      env: {
        OLLAMA_HOST: FAKE_OLLAMA_BASE_URL,
        OLLAMA_MODEL: FAKE_OLLAMA_MODEL,
        CLASSIFY_MIN_CONFIDENCE: String(file.threshold),
      },
      fetch: fake.fetch,
    });
    for (const department of file.catalogues[evalCase.catalogue] ?? []) {
      const { active, ...create } = department;
      host.createDepartment(create);
      if (!active) host.updateDepartment({ id: department.id, active: false });
    }
    for (const entry of evalCase.history) {
      const view = await host.classify(entry.ticket);
      if (entry.override) host.override({ id: view.id, departmentId: entry.override });
    }
    const view = await host.classify(evalCase.ticket);
    const problems: string[] = [];
    if (fake.remaining() > 0) problems.push(`the model was called ${fake.remaining()} time(s) fewer than scripted`);
    if (fake.unexpectedCalls() > 0) problems.push(`the model was called ${fake.unexpectedCalls()} time(s) more than scripted`);
    const { decision } = view;
    return {
      outcome: {
        status: decision.status,
        departmentId: decision.status === 'labeled' ? decision.departmentId : null,
        confidence: decision.confidence,
        quote: decision.quote,
        taxonomyVersion: decision.taxonomyVersion,
      },
      problems,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCase(file: SuiteFile, evalCase: EvalCase): Promise<CaseResult> {
  const base = {
    suite: file.suite,
    id: evalCase.id,
    source: evalCase.source,
    catalogue: evalCase.catalogue,
    expected: evalCase.expect,
  };
  try {
    const { outcome, problems } = await classifyCase(file, evalCase, evalCase.reply);
    problems.push(...judge(evalCase.expect, outcome, file.threshold));
    if (evalCase.wrongReply) {
      const wrong = await classifyCase(file, evalCase, evalCase.wrongReply);
      if (judge(evalCase.expect, wrong.outcome, file.threshold).length === 0) {
        problems.push('wrongReply also meets the expectation, so the case cannot catch that answer');
      }
    }
    return { ...base, actual: outcome, passed: problems.length === 0, problems };
  } catch (error) {
    // Host errors carry fixed messages (no ticket text, no address).
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ...base, actual: null, passed: false, problems: [`run error: ${message}`] };
  }
}

export async function runSuite(file: SuiteFile): Promise<SuiteRun> {
  const results: CaseResult[] = [];
  for (const evalCase of file.cases) results.push(await runCase(file, evalCase));
  const catalogues = Object.entries(file.catalogues).map(([name, departments]) => ({
    suite: file.suite,
    name,
    hash: catalogueHash(departments),
    taxonomyVersion: results.find((r) => r.catalogue === name && r.actual)?.actual?.taxonomyVersion ?? null,
  }));
  return { suite: file.suite, threshold: file.threshold, results, catalogues };
}
