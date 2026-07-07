import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "DaemonRequestError",
      "RuntimeUseCaseException",
      "admitPreparedWorkflowRun",
      "applyRunControl",
      "applySignalRunControl",
      "createWorkflowVisualizationOverlay",
      "daemonEndpoint",
      "formatHookLoadError",
      "getArtifact",
      "getRun",
      "getRunInspection",
      "getRunStaticVisualizationOverlay",
      "getRunVisualizationSnapshot",
      "getRuntimeHealth",
      "globalHooksPath",
      "hookEvents",
      "listArtifacts",
      "listRuns",
      "loadHooksConfigScope",
      "loadHooksConfigScopes",
      "normalizeForkInput",
      "normalizeSignalPayload",
      "normalizeWorkflowInput",
      "projectHooksPath",
      "requestDaemonControl",
      "requestDaemonObserveRun",
      "requestDaemonShutdown",
      "requestDaemonStartRun",
      "requestDaemonStatus",
      "startDaemonLoop",
      "validateAgentOverrides",
      "validateHooksFile",
    ]);
  });
});
