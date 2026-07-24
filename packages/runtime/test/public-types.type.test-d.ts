import { expectTypeOf, test } from "vitest";
import type {
  AgentInspectionState,
  AgentOutputProcessing,
  AgentTraceRecord,
  AgentTurnArtifact,
  AgentOverrideMap,
  ArtifactRecord,
  PreparedRunWorkflow,
  RunDynamicAttempt,
  RunDynamicDetails,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunNodeProgress,
  RunInspectionEmission,
  RunInspectionAction,
  RunInspectionDetailedFailure,
  RunInspectionItem,
  RunInspectionPatch,
  RunInspectionRaw,
  RunInspectionRunSummary,
  RunInspectionScopeState,
  RunDynamicSignalWait,
  RunDetails,
  RunForkInfo,
  RunRecord,
  RunStatus,
  RunWorkflowLockArtifact,
  RuntimeHealthCheck,
  RuntimeHealthReport,
  RuntimePersistence,
  RuntimeConfiguration,
  RuntimeConfigurationFailure,
  AgentHostPolicy,
  AgentHostPolicyFailure,
  DaemonControlIntent,
  DaemonControlResult,
  DaemonLoopHandle,
  DaemonLoopOptions,
  DaemonShutdownResult,
  DaemonAdmitRunInput,
  DaemonStatus,
  DaemonClientFailure,
  RunDeleteFailure,
  AdmitRunFailure,
  ForkInputNormalizationFailure,
  SchemaNormalizationFailure,
  AgentOverrideValidationFailure,
  PreparedRunValidationFailure,
  RunIncident,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
} from "@acpus/runtime";
import { createWorkflowVisualizationOverlay, daemonEndpoint, deleteRun, getRun, getRuntimeHealth, getRunVisualizationSnapshot, listArtifacts, listRuns, requestDaemonAdmitRun, requestDaemonControl, requestDaemonShutdown, requestDaemonStatus, startDaemonLoop, tryLoadRuntimeConfiguration, tryNormalizeForkInput, tryNormalizeWorkflowInput, tryValidateAgentOverrides } from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTurnSummary } from "@acpus/agent-executor";
import type { Result, ResultAsync } from "neverthrow";

test("@acpus/runtime public types describe runtime read and daemon APIs", () => {
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(listArtifacts).toEqualTypeOf<(cwd: string, runId: string) => Promise<ArtifactRecord[] | undefined>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationSnapshot).toEqualTypeOf<(cwd: string, runId: string) => Promise<{ run: RunDetails; overlay: WorkflowVisualizationOverlay } | undefined>>();
  expectTypeOf(tryNormalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => ResultAsync<JsonValue | undefined, ForkInputNormalizationFailure>>();
  expectTypeOf(tryNormalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => Result<JsonValue, SchemaNormalizationFailure>>();
  expectTypeOf(tryValidateAgentOverrides).toEqualTypeOf<(ir: WorkflowIR, input: AgentOverrideMap | undefined) => Result<AgentOverrideMap, AgentOverrideValidationFailure>>();
  expectTypeOf<AdmitRunFailure>().toEqualTypeOf<PreparedRunValidationFailure | SchemaNormalizationFailure | AgentOverrideValidationFailure>();
  expectTypeOf(deleteRun).toEqualTypeOf<(cwd: string, runId: string) => ResultAsync<RunRecord | undefined, RunDeleteFailure>>();
  expectTypeOf<DaemonLoopOptions>().toEqualTypeOf<{
    heartbeatMs?: number;
    packageVersion: string;
    idleStopMs?: number;
    onShutdown?: () => void;
    onRunIncident?: (incident: RunIncident) => void;
  }>();
  expectTypeOf(startDaemonLoop).toEqualTypeOf<(cwd: string, options: DaemonLoopOptions) => Promise<DaemonLoopHandle>>();
  expectTypeOf(tryLoadRuntimeConfiguration).toEqualTypeOf<(env: NodeJS.ProcessEnv) => Result<RuntimeConfiguration, RuntimeConfigurationFailure>>();
  expectTypeOf<RuntimeConfiguration>().toEqualTypeOf<{
    runMaxLeafConcurrency: number;
    agentHostPolicy: AgentHostPolicy;
  }>();
  expectTypeOf<AgentHostPolicy["responseRepair"]>().toEqualTypeOf<
    | { type: "valid"; max: number }
    | { type: "invalid"; failure: AgentHostPolicyFailure }
  >();
  expectTypeOf(daemonEndpoint).toEqualTypeOf<(cwd: string) => string>();
  expectTypeOf(requestDaemonStatus).toEqualTypeOf<(cwd: string) => ResultAsync<DaemonStatus, DaemonClientFailure>>();
  expectTypeOf(requestDaemonAdmitRun).toEqualTypeOf<(cwd: string, input: DaemonAdmitRunInput) => ResultAsync<RunDetails, DaemonClientFailure>>();
  expectTypeOf(requestDaemonControl).toEqualTypeOf<(cwd: string, control: DaemonControlIntent) => ResultAsync<DaemonControlResult, DaemonClientFailure>>();
  expectTypeOf(requestDaemonShutdown).toEqualTypeOf<(cwd: string) => ResultAsync<DaemonShutdownResult, DaemonClientFailure>>();
  expectTypeOf(createWorkflowVisualizationOverlay).toMatchTypeOf<(ir: WorkflowIR, dynamic?: RunDynamicDetails, options?: { runId?: string; status?: string }) => WorkflowVisualizationOverlay>();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<RunDetails["fork"]>().toEqualTypeOf<RunForkInfo | undefined>();
  expectTypeOf<RunForkInfo>().toEqualTypeOf<{ sourceRunId: string; target?: string; unsafeReuse?: true }>();
  expectTypeOf<DaemonStatus>().toMatchTypeOf<{ status: "ok"; pid: number; generation: number; protocolVersion: number; packageVersion: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "pause" | "resume" }>>().toEqualTypeOf<{ requestId: string; type: "pause" | "resume"; runId: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "retry" | "cancel" }>>().toEqualTypeOf<{ requestId: string; type: "retry" | "cancel"; runId: string; target?: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "fork" }>>().toMatchTypeOf<{ requestId: string; type: "fork"; runId: string; target?: string; input?: JsonValue; unsafeReuse?: boolean }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "signal" }>>().toEqualTypeOf<{ requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue }>();
  expectTypeOf<DaemonControlResult>().toEqualTypeOf<
    | { type: "pause"; state: "applied"; run: RunDetails }
    | { type: "resume"; state: "applied"; run: RunDetails }
    | { type: "retry"; state: "applied"; run: RunDetails; target?: string }
    | { type: "cancel"; state: "applied"; run: RunDetails; target?: string }
    | { type: "fork"; state: "applied"; sourceRunId: string; run: RunDetails }
    | {
      type: "signal";
      state: "consumed";
      requestedTarget: string;
      target: string;
      validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
      run: RunDetails;
    }
  >();
  expectTypeOf<NonNullable<RunDetails["dynamic"]>>().toEqualTypeOf<RunDynamicDetails>();
  expectTypeOf<RunDynamicDetails["frames"][number]>().toEqualTypeOf<RunDynamicFrame>();
  expectTypeOf<RunDynamicDetails["nodeInstances"][number]>().toEqualTypeOf<RunDynamicNodeInstance>();
  expectTypeOf<RunDynamicDetails["attempts"][number]>().toEqualTypeOf<RunDynamicAttempt>();
  expectTypeOf<RunDynamicDetails["groupMembers"][number]>().toEqualTypeOf<RunDynamicGroupMember>();
  expectTypeOf<RunDynamicDetails["signalWaits"][number]>().toEqualTypeOf<RunDynamicSignalWait>();
  expectTypeOf<RunDynamicSignalWait>().toMatchTypeOf<{ payload?: JsonValue; consumedAt?: string }>();
  expectTypeOf<RunDynamicDetails["progress"][number]>().toEqualTypeOf<RunNodeProgress>();
  expectTypeOf<RunDynamicDetails["progressVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<RunRecord["progressVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<RunNodeProgress>().toMatchTypeOf<{
    nodeKey: string;
    nodeId: string;
    attemptId?: string;
    attemptNo?: number;
    kind: string;
    status: string;
    message?: string;
    output?: { tail: string; totalBytes: number; truncated: boolean };
    context?: unknown;
    tokenUsage?: unknown;
    tools?: unknown;
    updatedAt: string;
  }>();
  expectTypeOf<AgentInspectionState>().toMatchTypeOf<{
    key: string;
    availability: { context: "available" | "unavailable"; tokenUsage: "available" | "partial" | "unavailable" };
    backend?: { kind: "use"; name: string } | { kind: "command" };
    tools?: { totalCallCount: number; recent: Array<{ command: string; status?: string }> };
  }>();
  expectTypeOf<RunInspectionRunSummary["agentUsage"]>().toEqualTypeOf<{ instances: number; attempts: number; turns: number } | undefined>();
  expectTypeOf<RunInspectionRunSummary["fork"]>().toEqualTypeOf<RunForkInfo | undefined>();
  expectTypeOf<NonNullable<RunInspectionItem["scope"]>>().toEqualTypeOf<RunInspectionScopeState>();
  expectTypeOf<Extract<RunInspectionAction, { kind: "inspect-target" | "signal" | "retry" }>>().toMatchTypeOf<{ itemKey: string }>();
  expectTypeOf<RunInspectionPatch>().toMatchTypeOf<{
    upsertItems: RunInspectionItem[];
    removeItemKeys: string[];
    itemOrder?: string[];
  }>();
  expectTypeOf<Extract<RunInspectionEmission, { kind: "update" }>["patch"]>().toEqualTypeOf<RunInspectionPatch>();
  expectTypeOf<RunInspectionRaw["workflow"]>().toEqualTypeOf<WorkflowIR>();
  expectTypeOf<RunInspectionDetailedFailure>().toMatchTypeOf<{
    origin: string;
    message: string;
    upstream?: { source: "acpx"; data?: JsonValue };
  }>();
  expectTypeOf<Extract<RunInspectionEmission, { kind: "update" }>["changes"][number]>().toMatchTypeOf<{
    summary?: { kind: "omitted-agent-progress"; changed: number; tracked: number };
  }>();
  expectTypeOf<NonNullable<RunDynamicFrame["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<NonNullable<RunDynamicNodeInstance["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicFrame["instancePath"]>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicNodeInstance["instancePath"]>();
  expectTypeOf<RunDynamicGroupMember["completionSequence"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<WorkflowVisualizationOverlay["nodes"][number]>().toEqualTypeOf<WorkflowVisualizationNode>();
  expectTypeOf<WorkflowVisualizationOverlay["groups"][number]>().toEqualTypeOf<WorkflowVisualizationGroup>();
  expectTypeOf<RunStatus>().toEqualTypeOf<"pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled">();
  expectTypeOf<RuntimeHealthReport["checks"][number]>().toEqualTypeOf<RuntimeHealthCheck>();
  expectTypeOf<RuntimeHealthReport["persistence"]>().toEqualTypeOf<RuntimePersistence | undefined>();
  expectTypeOf<Extract<RuntimeHealthReport, { state: "not-initialized" }>["persistence"]>().toEqualTypeOf<RuntimePersistence>();
  expectTypeOf<Extract<RuntimeHealthReport, { state: "ready" }>["persistence"]>().toEqualTypeOf<RuntimePersistence>();
  expectTypeOf<RuntimePersistence>().toEqualTypeOf<{ path: string }>();
  expectTypeOf<AgentOutputProcessing>().toEqualTypeOf<
    | { outcome: "accepted"; parsing: "direct" | "repaired"; projectionChanged: boolean }
    | { outcome: "rejected"; phase: "framing" | "json" }
    | { outcome: "rejected"; phase: "schema"; parsing: "direct" | "repaired"; projectionChanged: boolean }
  >();
  expectTypeOf<Extract<AgentTraceRecord, { type: "turn_start" }>>().toMatchTypeOf<{ schemaVersion: 1; sequence: number; runId: string; nodeId: string }>();
  expectTypeOf<AgentTurnArtifact>().toEqualTypeOf<{
    schemaVersion: 1;
    runId: string;
    nodeId: string;
    nodeKey: string;
    attemptNo: number;
    turn: number;
    agentKey: string;
    sessionName: string;
    status: "completed" | "failed" | "cancelled";
    timing: import("@acpus/agent-executor").AgentTurnTiming;
    prompt: string;
    response: string;
    summary: AgentTurnSummary;
    failure?: import("@acpus/agent-executor").AgentBackendFailure;
    message?: string;
  }>();
});
