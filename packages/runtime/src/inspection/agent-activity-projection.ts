import type {
  AgentObservationCurrent,
  AgentObservationInspectionProjection,
  AgentObservationTurn,
} from "../observations/log.js";
import type {
  AgentCurrentActivity,
  RunInspectionStatus,
} from "./types.js";

type AgentActivitySubject = {
  status: RunInspectionStatus;
  updatedAt: string;
  attemptId?: string;
  attemptNo?: number;
};

type ProjectedAgentActivity = {
  phase: AgentCurrentActivity["phase"];
  updatedAt: string;
  turn?: number;
  current?: AgentCurrentActivity;
};

type AgentActivityProjector = (
  subject: AgentActivitySubject,
) => ProjectedAgentActivity | undefined;

export function createAgentActivityProjector(
  observations?: AgentObservationInspectionProjection,
): AgentActivityProjector {
  const turns = new Map<string, AgentObservationTurn>();
  for (const candidate of observations?.turns ?? []) {
    const selected = turns.get(candidate.attemptId);
    if (!selected || candidate.turn > selected.turn) turns.set(candidate.attemptId, candidate);
  }
  const currents = new Map<string, AgentObservationCurrent>();
  for (const candidate of observations?.currents ?? []) {
    if (candidate.turn !== turns.get(candidate.attemptId)?.turn) continue;
    const selected = currents.get(candidate.attemptId);
    if (!selected || candidate.updatedAt > selected.updatedAt) currents.set(candidate.attemptId, candidate);
  }
  return subject => projectAgentActivity(
    subject,
    subject.attemptId ? turns.get(subject.attemptId) : undefined,
    subject.attemptId ? currents.get(subject.attemptId) : undefined,
  );
}

function projectAgentActivity(
  subject: AgentActivitySubject,
  turn: AgentObservationTurn | undefined,
  current: AgentObservationCurrent | undefined,
): ProjectedAgentActivity | undefined {
  if (terminalStatus(subject.status)) {
    const updatedAt = turn?.finishedAt ?? subject.updatedAt;
    const projectedCurrent: AgentCurrentActivity | undefined = subject.attemptId
      ? {
          kind: "agent",
          attemptId: subject.attemptId,
          ...(subject.attemptNo === undefined ? {} : { attemptNo: subject.attemptNo }),
          ...(turn ? { turn: turn.turn, turnKind: turn.promptKind } : {}),
          phase: "settled",
          updatedAt,
        }
      : undefined;
    return {
      phase: "settled",
      updatedAt,
      ...(turn ? { turn: turn.turn } : {}),
      ...(projectedCurrent ? { current: projectedCurrent } : {}),
    };
  }
  if (!subject.attemptId || !turn || !current) return undefined;
  const phase = publicPhase(current.phase);
  if (!phase) return undefined;
  const active = current.tools?.active ?? [];
  const projectedCurrent: AgentCurrentActivity = {
    kind: "agent",
    attemptId: subject.attemptId,
    ...(subject.attemptNo === undefined ? {} : { attemptNo: subject.attemptNo }),
    ...(current.postFence ? { postFence: true } : {}),
    turn: current.turn,
    turnKind: current.promptKind,
    phase,
    updatedAt: current.updatedAt,
    ...(current.response ? { response: current.response } : {}),
    ...(current.intent ? { intent: current.intent } : {}),
    ...(active.length > 0
      ? { tools: { active, omittedActive: current.tools?.omittedActive ?? 0 } }
      : {}),
  };
  return {
    phase,
    turn: current.turn,
    updatedAt: current.updatedAt,
    current: projectedCurrent,
  };
}

function publicPhase(
  phase: AgentObservationCurrent["phase"],
): AgentCurrentActivity["phase"] | undefined {
  switch (phase) {
    case "starting": return "starting";
    case "responding": return "responding";
    case "thinking": return "reported-thought";
    case "planning": return "planning";
    case "tool": return "tool";
    case "repairing": return "output-repair";
    case "between": return undefined;
    case "settled": return "settling";
  }
  return unreachable(phase);
}

function terminalStatus(status: RunInspectionStatus): boolean {
  switch (status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "cancelled":
    case "not_selected": return true;
    case "not_started":
    case "pending":
    case "starting":
    case "ready":
    case "running":
    case "awaiting":
    case "mixed": return false;
  }
  return unreachable(status);
}

function unreachable(value: never): never {
  throw new Error(`Unknown Agent activity value '${String(value)}'.`);
}
