import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "createWorkflowVisualizationOverlay",
      "daemonEndpoint",
      "deleteRun",
      "followRunInspection",
      "formatHookLoadError",
      "getArtifact",
      "getRun",
      "getRunInspection",
      "getRunVisualizationSnapshot",
      "getRuntimeHealth",
      "globalHooksPath",
      "hookEvents",
      "listArtifacts",
      "listRuns",
      "loadHooksConfigScope",
      "loadHooksConfigScopes",
      "projectHooksPath",
      "requestDaemonAdmitRun",
      "requestDaemonControl",
      "requestDaemonShutdown",
      "requestDaemonStatus",
      "startDaemonLoop",
      "tryLoadRuntimeConfiguration",
      "tryNormalizeForkInput",
      "tryNormalizeWorkflowInput",
      "tryValidateAgentOverrides",
      "validateHooksFile",
    ]);
  });
});
