import { describe, expect, it } from "vitest";
import * as runtime from "@acpus/runtime";
import * as host from "@acpus/runtime/host";

describe("@acpus/runtime public API", () => {
  it("exports durable runtime use cases and testable pure runtime helpers", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "AUTHORING_AGENT_SCALE_ENV",
      "DAEMON_PROTOCOL_VERSION",
      "RUNTIME_ABI_VERSION",
      "addAgentPreset",
      "applyAgentPresetChanges",
      "awaitRuntimeStoreOffline",
      "createWorkflowVisualizationOverlay",
      "daemonEndpoint",
      "deleteRun",
      "finalizeAgentBindings",
      "formatHookLoadError",
      "getArtifact",
      "getRun",
      "getRunVisualizationSnapshot",
      "getRuntimeHealth",
      "globalAcpusConfigPath",
      "hasPresetInjections",
      "hookEvents",
      "inspectAgentExecution",
      "inspectNode",
      "inspectRuntimeStore",
      "inspectTargetArtifacts",
      "listArtifacts",
      "listKnownWorkspaces",
      "listRuns",
      "loadAcpusConfigScope",
      "loadAgentAuthoringContext",
      "loadAgentPresetCatalog",
      "loadAuthoringAgentScale",
      "loadHooksConfigScope",
      "loadHooksConfigScopes",
      "normalizeAuthoringAgentScale",
      "observeInspection",
      "parseAgentInjectionMap",
      "probeDaemonEndpoint",
      "projectAcpusConfigPath",
      "pruneRuns",
      "readArtifact",
      "readInspection",
      "removeAgentPreset",
      "repairRuntimeStore",
      "requestDaemonControl",
      "requestDaemonInspection",
      "requestDaemonShutdown",
      "requestDaemonStatus",
      "requestDaemonStatusProbe",
      "requestDaemonSubmitAndObserve",
      "requestPredecessorDaemonShutdown",
      "resolveArtifact",
      "resolveConfiguredAgentCommand",
      "resolveKnownWorkspace",
      "setAuthoringAgentScale",
      "startDaemonLoop",
      "tryLoadRuntimeConfiguration",
      "tryNormalizeForkInput",
      "tryNormalizeWorkflowInput",
      "tryParseAgentInjectionMap",
      "unboundAgentNames",
      "unsetAuthoringAgentScale",
      "validateHooksFile",
      "withAgentBindings",
    ]);
  });
});

describe("@acpus/runtime/host public API", () => {
  it("exports only the embeddable Runtime constructor", () => {
    expect(Object.keys(host).sort()).toEqual(["openWorkspaceRuntime"]);
  });
});
