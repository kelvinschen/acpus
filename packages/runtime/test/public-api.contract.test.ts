import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "admitWorkflowRun",
      "createWorkflowVisualizationOverlay",
      "getRun",
      "getRunVisualizationOverlay",
      "listRuns",
      "mutateRun",
      "normalizeForkInput",
      "normalizeSignalPayload",
      "normalizeWorkflowInput",
      "queueSupervisorShutdown",
      "replayRun",
      "signalRun",
      "startSupervisorLoop",
    ]);
  });
});
