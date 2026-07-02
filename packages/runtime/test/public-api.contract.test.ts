import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "admitPreparedWorkflowRun",
      "admitWorkflowRun",
      "advanceWorkflowRun",
      "applyRunControl",
      "applySignalRunControl",
      "createWorkflowVisualizationOverlay",
      "getRun",
      "getRunVisualizationOverlay",
      "getRuntimeHealth",
      "listRuns",
      "mutateRun",
      "normalizeForkInput",
      "normalizeSignalPayload",
      "normalizeWorkflowInput",
      "queueSupervisorShutdown",
      "releaseWorkflowRunOwner",
      "replayRun",
      "signalRun",
      "startSupervisorLoop",
      "tryAdmitWorkflowRun",
      "tryAdvanceRun",
      "tryAdvanceRuntimeRun",
      "tryMutateRun",
      "trySignalRun",
      "validateAgentOverrides",
    ]);
  });
});
