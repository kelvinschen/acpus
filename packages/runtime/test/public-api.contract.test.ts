import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "DAEMON_PROTOCOL_VERSION",
      "createWorkflowVisualizationOverlay",
      "daemonEndpoint",
      "deleteRun",
      "formatHookLoadError",
      "getArtifact",
      "getRun",
      "getRunVisualizationSnapshot",
      "getRuntimeHealth",
      "globalHooksPath",
      "hookEvents",
      "inspectAgentExecution",
      "inspectNode",
      "inspectRuntimeStore",
      "inspectTargetArtifacts",
      "listArtifacts",
      "listKnownWorkspaces",
      "listRuns",
      "loadHooksConfigScope",
      "loadHooksConfigScopes",
      "observeInspection",
      "projectHooksPath",
      "pruneRuns",
      "readArtifact",
      "readInspection",
      "repairRuntimeStore",
      "requestDaemonAdmitRun",
      "requestDaemonControl",
      "requestDaemonShutdown",
      "requestDaemonStatus",
      "resolveArtifact",
      "resolveKnownWorkspace",
      "startDaemonLoop",
      "tryLoadRuntimeConfiguration",
      "tryNormalizeForkInput",
      "tryNormalizeWorkflowInput",
      "tryValidateAgentOverrides",
      "validateHooksFile",
    ]);
  });
});
