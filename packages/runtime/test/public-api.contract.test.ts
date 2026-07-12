import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "DaemonRequestError",
      "RuntimeUseCaseException",
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
      "listRuns",
      "loadHooksConfigScope",
      "loadHooksConfigScopes",
      "normalizeForkInput",
      "normalizeWorkflowInput",
      "projectHooksPath",
      "requestDaemonAdmitRun",
      "requestDaemonControl",
      "requestDaemonShutdown",
      "requestDaemonStatus",
      "startDaemonLoop",
      "tryLoadRuntimeConfiguration",
      "validateAgentOverrides",
      "validateHooksFile",
    ]);
  });
});
