import { expectTypeOf, test } from "vitest";
import type {
  AgentInspectionState,
  AgentOverrideMap,
  PreparedRunWorkflow,
  RunDynamicAttempt,
  RunDynamicDetails,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunNodeProgress,
  RunInspectionEmission,
  RunInspectionDetailedFailure,
  RunInspectionItem,
  RunInspectionPatch,
  RunInspectionRaw,
  RunDynamicSignalWait,
  RunDetails,
  RunRecord,
  RunStatus,
  RunWorkflowLockArtifact,
  RuntimeHealthCheck,
  RuntimeHealthReport,
  DaemonControlIntent,
  DaemonControlResult,
  DaemonErrorCode,
  DaemonLoopHandle,
  DaemonLoopOptions,
  DaemonShutdownResult,
  DaemonAdmitRunInput,
  DaemonStatus,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
} from "@acpus/runtime";
import { DaemonRequestError, RuntimeUseCaseException, createWorkflowVisualizationOverlay, daemonEndpoint, getRun, getRuntimeHealth, getRunVisualizationSnapshot, listRuns, normalizeForkInput, normalizeWorkflowInput, requestDaemonAdmitRun, requestDaemonControl, requestDaemonShutdown, requestDaemonStatus, startDaemonLoop, validateAgentOverrides } from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";

test("@acpus/runtime public types describe runtime read and daemon APIs", () => {
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationSnapshot).toEqualTypeOf<(cwd: string, runId: string) => Promise<{ run: RunDetails; overlay: WorkflowVisualizationOverlay } | undefined>>();
  expectTypeOf(normalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => Promise<JsonValue | undefined>>();
  expectTypeOf(normalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => JsonValue>();
  expectTypeOf(validateAgentOverrides).toEqualTypeOf<(ir: WorkflowIR, input: AgentOverrideMap | undefined) => AgentOverrideMap>();
  expectTypeOf<DaemonLoopOptions>().toEqualTypeOf<{
    heartbeatMs?: number;
    packageVersion: string;
    idleStopMs?: number;
    onShutdown?: () => void;
  }>();
  expectTypeOf(startDaemonLoop).toEqualTypeOf<(cwd: string, options: DaemonLoopOptions) => Promise<DaemonLoopHandle>>();
  expectTypeOf(daemonEndpoint).toEqualTypeOf<(cwd: string) => string>();
  expectTypeOf(requestDaemonStatus).toEqualTypeOf<(cwd: string) => Promise<DaemonStatus>>();
  expectTypeOf(requestDaemonAdmitRun).toEqualTypeOf<(cwd: string, input: DaemonAdmitRunInput) => Promise<RunDetails>>();
  expectTypeOf(requestDaemonControl).toEqualTypeOf<(cwd: string, control: DaemonControlIntent) => Promise<DaemonControlResult>>();
  expectTypeOf(requestDaemonShutdown).toEqualTypeOf<(cwd: string) => Promise<DaemonShutdownResult>>();
  expectTypeOf(new DaemonRequestError("RUN_NOT_CONTROLLABLE", "failed").code).toEqualTypeOf<DaemonErrorCode>();
  expectTypeOf(new RuntimeUseCaseException({ type: "run-delete-active", runId: "run_1", message: "active" }).failure).toEqualTypeOf<{ type: "run-delete-active"; runId: string; message: string }>();
  expectTypeOf(createWorkflowVisualizationOverlay).toMatchTypeOf<(ir: WorkflowIR, dynamic?: RunDynamicDetails, options?: { runId?: string; status?: string }) => WorkflowVisualizationOverlay>();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<DaemonStatus>().toMatchTypeOf<{ status: "ok"; pid: number; generation: number; protocolVersion: number; packageVersion: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "pause" | "resume" }>>().toEqualTypeOf<{ requestId: string; type: "pause" | "resume"; runId: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "retry" | "cancel" }>>().toEqualTypeOf<{ requestId: string; type: "retry" | "cancel"; runId: string; target?: string }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "fork" }>>().toMatchTypeOf<{ requestId: string; type: "fork"; runId: string; target?: string; input?: JsonValue; unsafeReuse?: boolean }>();
  expectTypeOf<Extract<DaemonControlIntent, { type: "signal" }>>().toEqualTypeOf<{ requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue }>();
  expectTypeOf<DaemonControlResult>().toEqualTypeOf<{ run: RunDetails; forkRunId?: string }>();
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
    backend?: { kind: "use"; name: string } | { kind: "command" };
    tools?: { totalCallCount: number; recent: Array<{ command: string; status?: string }> };
  }>();
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
});
