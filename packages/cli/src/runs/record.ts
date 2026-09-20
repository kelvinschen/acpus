import type { DaemonControlResult, RunDetails, RunRecord } from "@acpus/runtime";
import type { CliAppliedControl } from "../presentation/output.js";

export function toRunRecord(run: RunDetails): RunRecord {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    workflowEntry: run.workflowEntry,
    sourceGraphDigest: run.sourceGraphDigest,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progressVersion: run.progressVersion,
    ...(run.progressUpdatedAt === undefined ? {} : { progressUpdatedAt: run.progressUpdatedAt }),
  };
}

export function appliedControl(result: DaemonControlResult, requestedTarget?: string): CliAppliedControl {
  switch (result.type) {
    case "pause":
    case "resume":
      return { type: result.type, state: "applied", runId: result.run.id };
    case "retry":
      return { type: "retry", state: "applied", runId: result.run.id, target: requestedTarget ?? result.target };
    case "cancel":
      return {
        type: result.type,
        state: "applied",
        runId: result.run.id,
        ...((requestedTarget ?? result.target) === undefined
          ? {}
          : { target: requestedTarget ?? result.target! }),
      };
    case "fork":
      return { type: "fork", state: "applied", sourceRunId: result.sourceRunId };
    case "signal":
      return {
        type: "signal",
        state: "consumed",
        runId: result.run.id,
        target: requestedTarget ?? result.requestedTarget,
        validation: result.validation,
      };
    case "steer":
      return {
        type: "steer",
        state: "applied",
        runId: result.run.id,
        steerId: result.steerId,
        target: requestedTarget ?? result.requestedTarget,
        delivery: result.delivery,
        continuation: result.continuation,
      };
  }
}
