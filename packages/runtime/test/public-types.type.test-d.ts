import { expectTypeOf, test } from "vitest";
import type {
  AgentOverrideMap,
  ForkSeedFailure,
  ForkPreparedWorkflow,
  PreparedRunWorkflow,
  RunDynamicAttempt,
  RunDynamicDetails,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunNodeProgress,
  RunDynamicSignalWait,
  RunDetails,
  RunRecord,
  RunStatus,
  RunWorkflowLockArtifact,
  RuntimeAdvanceResult,
  RuntimeHealthCheck,
  RuntimeHealthReport,
  RuntimeMutationAction,
  RuntimeMutationInput,
  RuntimeMutationResult,
  RuntimeUseCaseError,
  SchedulerStoreError,
  SchedulerStoreResult,
  DaemonControlIntent,
  DaemonErrorCode,
  DaemonLoopHandle,
  DaemonLoopOptions,
  DaemonWork,
  DaemonShutdownResult,
  DaemonAdmitRunInput,
  DaemonStatus,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
  RunVisualizationSnapshot,
} from "@acpus/runtime";
import { DaemonRequestError, RuntimeUseCaseException, admitPreparedWorkflowRun, createWorkflowVisualizationOverlay, daemonEndpoint, getRun, getRuntimeHealth, getRunVisualizationSnapshot, listRuns, normalizeForkInput, normalizeSignalPayload, normalizeWorkflowInput, requestDaemonAdmitRun, requestDaemonControl, requestDaemonObserveRun, requestDaemonShutdown, requestDaemonStartRun, requestDaemonStatus, startDaemonLoop, validateAgentOverrides } from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { Result } from "neverthrow";

test("@acpus/runtime public types describe use-case level runtime APIs", () => {
  expectTypeOf(admitPreparedWorkflowRun).toEqualTypeOf<(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap) => Promise<RunDetails>>();
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationSnapshot).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunVisualizationSnapshot | undefined>>();
  expectTypeOf(normalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => Promise<JsonValue | undefined>>();
  expectTypeOf(normalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => JsonValue>();
  expectTypeOf(normalizeSignalPayload).toEqualTypeOf<(ir: WorkflowIR, nodeId: string, payload: JsonValue) => JsonValue>();
  expectTypeOf(validateAgentOverrides).toEqualTypeOf<(ir: WorkflowIR, input: AgentOverrideMap | undefined) => AgentOverrideMap>();
  expectTypeOf(startDaemonLoop).toEqualTypeOf<(cwd: string, options: DaemonLoopOptions) => Promise<DaemonLoopHandle>>();
  expectTypeOf(daemonEndpoint).toEqualTypeOf<(cwd: string) => string>();
  expectTypeOf(requestDaemonStatus).toEqualTypeOf<(cwd: string) => Promise<DaemonStatus>>();
  expectTypeOf(requestDaemonAdmitRun).toEqualTypeOf<(cwd: string, input: Omit<DaemonAdmitRunInput, "method">) => Promise<RunDetails>>();
  expectTypeOf(requestDaemonControl).toEqualTypeOf<(cwd: string, control: DaemonControlIntent) => Promise<RuntimeMutationResult>>();
  expectTypeOf(requestDaemonStartRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails>>();
  expectTypeOf(requestDaemonObserveRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RuntimeAdvanceResult>>();
  expectTypeOf(requestDaemonShutdown).toEqualTypeOf<(cwd: string) => Promise<DaemonShutdownResult>>();
  expectTypeOf(new DaemonRequestError("RUN_NOT_CONTROLLABLE", "failed").code).toEqualTypeOf<DaemonErrorCode>();
  expectTypeOf(new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "missing" }).failure).toEqualTypeOf<RuntimeUseCaseError>();
  expectTypeOf(createWorkflowVisualizationOverlay).toMatchTypeOf<(ir: WorkflowIR, dynamic?: RunDynamicDetails, options?: { runId?: string; status?: string }) => WorkflowVisualizationOverlay>();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<ForkPreparedWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<NonNullable<RunDetails["dynamic"]>>().toEqualTypeOf<RunDynamicDetails>();
  expectTypeOf<RunDynamicDetails["frames"][number]>().toEqualTypeOf<RunDynamicFrame>();
  expectTypeOf<Extract<RuntimeUseCaseError, { type: "fork-seed-failed" }>["cause"]>().toEqualTypeOf<ForkSeedFailure>();
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
  expectTypeOf<NonNullable<RunDynamicFrame["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<NonNullable<RunDynamicNodeInstance["instancePath"]>[number]>().toMatchTypeOf<{ kind: string }>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicFrame["instancePath"]>();
  expectTypeOf<undefined>().toMatchTypeOf<RunDynamicNodeInstance["instancePath"]>();
  expectTypeOf<RunDynamicGroupMember["completionSequence"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<WorkflowVisualizationOverlay["nodes"][number]>().toEqualTypeOf<WorkflowVisualizationNode>();
  expectTypeOf<WorkflowVisualizationOverlay["groups"][number]>().toEqualTypeOf<WorkflowVisualizationGroup>();
  expectTypeOf<RunStatus>().toEqualTypeOf<"pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled">();
  expectTypeOf<RuntimeMutationAction>().toEqualTypeOf<"pause" | "resume" | "retry" | "fork" | "cancel">();
  expectTypeOf<RuntimeHealthReport["checks"][number]>().toEqualTypeOf<RuntimeHealthCheck>();
  expectTypeOf<RuntimeMutationInput>().toMatchTypeOf<{ target?: string; unsafeReuse?: boolean }>();
  expectTypeOf<SchedulerStoreResult<unknown>>().toEqualTypeOf<Result<unknown, SchedulerStoreError>>();
  expectTypeOf<DaemonWork>().toEqualTypeOf<{ startableRuns: RunRecord[]; idleBlockers: number }>();
});
