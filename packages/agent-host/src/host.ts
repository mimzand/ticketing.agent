import { classifyTicketText } from '@ticket/adk-runtime';
import { type OllamaClient } from '@ticket/model-provider';
import {
  CLASSIFY_MIN_CONFIDENCE_DEFAULT,
  type ClassifyTicket,
  type CreateDepartment,
  type Decision,
  type Department,
  type ModelHealth,
  type OverrideTicket,
  type TicketView,
} from '@ticket/shared';
import { type TicketDatabase } from '@ticket/storage';

/** A request the host will not apply. The message names the rule, not the ticket text. */
export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostError';
  }
}

const FAILED: Decision = {
  departmentId: null,
  confidence: 0,
  rationale: 'The model could not be reached.',
  status: 'failed',
};

export interface AgentHost {
  listDepartments(): readonly Department[];
  createDepartment(input: CreateDepartment): Department;
  classify(input: ClassifyTicket): Promise<TicketView>;
  listTickets(): readonly TicketView[];
  override(input: OverrideTicket): TicketView;
  modelHealth(): Promise<ModelHealth>;
}

export function createAgentHost(options: {
  readonly db: TicketDatabase;
  readonly ollama: OllamaClient;
  readonly minConfidence?: number;
}): AgentHost {
  const minConfidence = options.minConfidence ?? CLASSIFY_MIN_CONFIDENCE_DEFAULT;
  let tail: Promise<void> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    listDepartments: () => options.db.listDepartments(),
    createDepartment(input) {
      if (options.db.listDepartments().some((department) => department.id === input.id)) {
        throw new HostError('A department with that id already exists.');
      }
      return options.db.insertDepartment(input);
    },
    listTickets: () => options.db.listRecent(),
    override(input) {
      const ticket = options.db.getById(input.id);
      if (!ticket) throw new HostError('No such ticket.');
      const department = options.db.listDepartments().find((item) => item.id === input.departmentId);
      if (!department?.active) throw new HostError('That department is not active.');
      options.db.saveDecision(ticket.id, {
        departmentId: department.id,
        confidence: ticket.decision.confidence,
        rationale: ticket.decision.rationale,
        status: 'overridden',
      });
      const updated = options.db.getById(ticket.id);
      if (!updated) throw new HostError('No such ticket.');
      return updated;
    },
    modelHealth: async () => ({
      reachable: await options.ollama.checkReachable(),
      model: options.ollama.config.model,
    }),
    classify: (input) => exclusive(() => classifyOnce(options.db, options.ollama, minConfidence, input)),
  };
}

async function classifyOnce(
  db: TicketDatabase,
  ollama: OllamaClient,
  minConfidence: number,
  input: ClassifyTicket,
): Promise<TicketView> {
  const stored = db.findByExternalId(input.externalId);
  if (stored) return stored;

  const created = db.insertTicket(input);
  const active = db.listDepartments().filter((department) => department.active);
  let decision: Decision;
  try {
    const output = await classifyTicketText({
      ollama,
      departments: active,
      ticket: input,
    });
    const known = active.some((department) => department.id === output.departmentId);
    if (!known || output.confidence < minConfidence) {
      decision = {
        departmentId: null,
        confidence: output.confidence,
        rationale: output.rationale,
        status: 'needs_review',
      };
    } else {
      decision = {
        departmentId: output.departmentId,
        confidence: output.confidence,
        rationale: output.rationale,
        status: 'labeled',
      };
    }
  } catch {
    decision = FAILED;
  }
  db.saveDecision(created.id, decision);
  const view = db.getById(created.id);
  if (!view) throw new HostError('No such ticket.');
  return view;
}
