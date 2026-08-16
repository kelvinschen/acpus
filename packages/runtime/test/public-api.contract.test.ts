import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";
import * as host from "@acpus/runtime/host";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "DAEMON_PROTOCOL_VERSION",
      "RUNTIME_ABI_VERSION",
      "awaitRuntimeStoreOffline",
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
      "probeDaemonEndpoint",
      "projectHooksPath",
      "pruneRuns",
      "readArtifact",
      "readInspection",
      "repairRuntimeStore",
      "requestDaemonControl",
      "requestDaemonShutdown",
      "requestDaemonStatus",
      "requestDaemonStatusProbe",
      "requestDaemonSubmitAndObserve",
      "requestPredecessorDaemonShutdown",
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

describe("@acpus/runtime/host public API", () => {
  it("exports only the embeddable Runtime constructor", () => {
    expect(Object.keys(host).sort()).toEqual(["openWorkspaceRuntime"]);
  });
});
