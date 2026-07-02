import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "admitWorkflowRun",
      "admitWorkflowRunOnly",
      "advanceWorkflowRun",
      "createWorkflowVisualizationOverlay",
      "getRun",
      "getRunVisualizationOverlay",
      "getRuntimeHealth",
      "listRuns",
      "mutateRun",
      "mutateRunControlOnly",
      "normalizeForkInput",
      "normalizeSignalPayload",
      "normalizeWorkflowInput",
      "queueSupervisorShutdown",
      "releaseWorkflowRunOwner",
      "replayRun",
      "signalRun",
      "signalRunControlOnly",
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
