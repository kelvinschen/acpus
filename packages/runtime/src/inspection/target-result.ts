import { isJsonValue } from "@acpus/expression/ir";
import type {
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
} from "../store/inspection-read-model.js";
import type { RunDetails } from "../store/store.js";
import type { ResolvedTargetState } from "./resolved-target.js";
import type { InspectionTargetResult, RunInspectionStatus } from "./types.js";

export type SelectedInspectionTarget = {
  attempt?: RunDynamicAttempt;
  instance?: RunDynamicNodeInstance;
  frame?: RunDynamicFrame;
  path?: RunDynamicNodeInstance["instancePath"];
};

export function selectInspectionTarget(details: ResolvedTargetState): SelectedInspectionTarget {
  const attempt = details.target.kind === "attempt"
    ? details.attempts.find(candidate => candidate.attemptId === details.target.id)
    : latestAttempt(details.attempts);
  const instance = details.target.kind === "dynamic-node"
    ? details.instances.find(candidate => candidate.nodeKey === details.target.id)
    : attempt
      ? details.instances.find(candidate => candidate.nodeKey === attempt.nodeKey)
      : details.summary.nodeKey
        ? details.instances.find(candidate => candidate.nodeKey === details.summary.nodeKey)
        : details.instances.length === 1 ? details.instances[0] : undefined;
  const frame = details.target.kind === "frame"
    ? details.frames.find(candidate => candidate.frameKey === details.target.id)
    : details.summary.frameKey
      ? details.frames.find(candidate => candidate.frameKey === details.summary.frameKey)
      : details.frames.length === 1 ? details.frames[0] : undefined;
  const path = instance?.instancePath ?? frame?.instancePath;
  return {
    ...(attempt === undefined ? {} : { attempt }),
    ...(instance === undefined ? {} : { instance }),
    ...(frame === undefined ? {} : { frame }),
    ...(path === undefined ? {} : { path }),
  };
}

export function projectInspectionTargetResult(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  status: RunInspectionStatus;
  selected?: SelectedInspectionTarget;
}): InspectionTargetResult | undefined {
  const selected = input.selected ?? selectInspectionTarget(input.details);
  if (input.details.target.id === "root") {
    return input.run.status === "completed" ? acceptedOutput(input.run.output) : undefined;
  }
  if (input.details.target.kind === "attempt") {
    if (selected.attempt?.status === "superseded") return { status: "not_accepted" };
    if (selected.attempt?.status !== "completed") return undefined;
    if (selected.instance?.acceptedAttemptId !== selected.attempt.attemptId) return { status: "not_accepted" };
    return acceptedOutput(selected.instance.output);
  }
  if (input.status !== "completed") return undefined;
  const kind = input.details.staticNode?.kind ?? input.details.summary.staticKind;
  if (kind && ["if", "switch", "parallel", "fanout", "loop", "assert"].includes(kind)) {
    return selected.frame?.status === "completed" ? acceptedOutput(selected.frame.result) : undefined;
  }
  return selected.instance?.status === "completed" ? acceptedOutput(selected.instance.output) : undefined;
}

function latestAttempt(attempts: readonly RunDynamicAttempt[]): RunDynamicAttempt | undefined {
  return [...attempts].sort((left, right) => right.attemptNo - left.attemptNo
    || right.startedAt.localeCompare(left.startedAt)
    || right.attemptId.localeCompare(left.attemptId))[0];
}

function acceptedOutput(value: unknown): InspectionTargetResult {
  if (value === undefined) return { status: "completed_without_output" };
  if (!isJsonValue(value)) throw new Error("Accepted inspection output is not JSON-compatible.");
  return { status: "accepted", value };
}
