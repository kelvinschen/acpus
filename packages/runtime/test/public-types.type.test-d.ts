import { expectTypeOf, test } from "vitest";
import type {
  AgentOverrideMap,
  AdvanceRunError,
  AdvanceRunInput,
  AdvanceRunSummary,
  CancelCommandPayload,
  ControlCommandType,
  EmptyCommandPayload,
  ForkPreparedWorkflow,
  PauseCommandPayload,
  PreparedRunWorkflow,
  ReplayResult,
  RunDynamicAttempt,
  RunDynamicDetails,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunDetails,
  RunRecord,
  RunControlCommandType,
  RunStatus,
  RunWorkflowLockArtifact,
  RuntimeAdvanceError,
  RuntimeAdvanceObserver,
  RuntimeAdvanceResult,
  RuntimeCommandRecord,
  RuntimeHealthCheck,
  RuntimeHealthReport,
  RuntimeMutationAction,
  RuntimeMutationInput,
  RuntimeMutationResult,
  RuntimeStore,
  RuntimeUseCaseError,
  RetryCommandPayload,
  SchedulerStoreError,
  SchedulerStoreResult,
  SignalCommandPayload,
  SubmitCommandInput,
  SupervisorCommandType,
  SupervisorLoopHandle,
  SupervisorLoopOptions,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
} from "@acpus/runtime";
import { admitPreparedWorkflowRun, admitWorkflowRun, advanceWorkflowRun, applyRunControl, applySignalRunControl, createWorkflowVisualizationOverlay, getRun, getRuntimeHealth, getRunVisualizationOverlay, listRuns, mutateRun, normalizeForkInput, normalizeSignalPayload, normalizeWorkflowInput, queueSupervisorShutdown, releaseWorkflowRunOwner, replayRun, signalRun, startSupervisorLoop, tryAdvanceRun, tryAdvanceRuntimeRun, tryAdmitWorkflowRun, tryMutateRun, trySignalRun, validateAgentOverrides } from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { Result, ResultAsync } from "neverthrow";

test("@acpus/runtime public types describe use-case level runtime APIs", () => {
  expectTypeOf(admitWorkflowRun).toMatchTypeOf<(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap) => Promise<unknown>>();
  expectTypeOf(admitPreparedWorkflowRun).toEqualTypeOf<(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap) => Promise<RunDetails>>();
  expectTypeOf(advanceWorkflowRun).toEqualTypeOf<(cwd: string, runId: string, ownerId?: string, observe?: RuntimeAdvanceObserver) => Promise<RuntimeAdvanceResult>>();
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRuntimeHealth).toEqualTypeOf<(cwd: string) => Promise<RuntimeHealthReport>>();
  expectTypeOf(getRunVisualizationOverlay).toEqualTypeOf<(cwd: string, runId: string) => Promise<WorkflowVisualizationOverlay | undefined>>();
  expectTypeOf(replayRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<ReplayResult | undefined>>();
  expectTypeOf(releaseWorkflowRunOwner).toEqualTypeOf<(cwd: string, runId: string, ownerId: string) => Promise<boolean>>();
  expectTypeOf(queueSupervisorShutdown).toEqualTypeOf<(cwd: string) => Promise<RuntimeCommandRecord | undefined>>();
  expectTypeOf(normalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => Promise<JsonValue | undefined>>();
  expectTypeOf(signalRun).toEqualTypeOf<(cwd: string, runId: string, nodeId: string, payload: JsonValue) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(applySignalRunControl).toEqualTypeOf<(cwd: string, runId: string, nodeId: string, payload: JsonValue) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(mutateRun).toEqualTypeOf<(cwd: string, runId: string, action: RuntimeMutationAction, input?: RuntimeMutationInput) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(applyRunControl).toEqualTypeOf<(cwd: string, runId: string, action: RuntimeMutationAction, input?: RuntimeMutationInput) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(tryAdmitWorkflowRun).toEqualTypeOf<(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap) => ResultAsync<RuntimeAdvanceResult, RuntimeUseCaseError>>();
  expectTypeOf(trySignalRun).toEqualTypeOf<(cwd: string, runId: string, nodeId: string, payload: JsonValue) => ResultAsync<RuntimeMutationResult, RuntimeUseCaseError>>();
  expectTypeOf(tryMutateRun).toEqualTypeOf<(cwd: string, runId: string, action: RuntimeMutationAction, input?: RuntimeMutationInput) => ResultAsync<RuntimeMutationResult, RuntimeUseCaseError>>();
  expectTypeOf(normalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => JsonValue>();
  expectTypeOf(normalizeSignalPayload).toEqualTypeOf<(ir: WorkflowIR, nodeId: string, payload: JsonValue) => JsonValue>();
  expectTypeOf(validateAgentOverrides).toEqualTypeOf<(ir: WorkflowIR, input: AgentOverrideMap | undefined) => AgentOverrideMap>();
  expectTypeOf(startSupervisorLoop).toEqualTypeOf<(cwd: string, options: SupervisorLoopOptions) => Promise<SupervisorLoopHandle>>();
  expectTypeOf(createWorkflowVisualizationOverlay).toMatchTypeOf<(ir: WorkflowIR, dynamic?: RunDynamicDetails, options?: { runId?: string; status?: string }) => WorkflowVisualizationOverlay>();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<ForkPreparedWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<NonNullable<RunDetails["dynamic"]>>().toEqualTypeOf<RunDynamicDetails>();
  expectTypeOf<RunDynamicDetails["frames"][number]>().toEqualTypeOf<RunDynamicFrame>();
  expectTypeOf<RunDynamicDetails["nodeInstances"][number]>().toEqualTypeOf<RunDynamicNodeInstance>();
  expectTypeOf<RunDynamicDetails["attempts"][number]>().toEqualTypeOf<RunDynamicAttempt>();
  expectTypeOf<RunDynamicDetails["groupMembers"][number]>().toEqualTypeOf<RunDynamicGroupMember>();
  expectTypeOf<RunDynamicDetails["signalWaits"][number]>().toEqualTypeOf<RunDynamicSignalWait>();
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
  expectTypeOf<RuntimeMutationInput>().toMatchTypeOf<{ target?: string }>();
  expectTypeOf<RunControlCommandType>().toEqualTypeOf<"pause" | "resume" | "retry" | "fork" | "signal" | "cancel">();
  expectTypeOf<SupervisorCommandType>().toEqualTypeOf<"shutdown">();
  expectTypeOf<ControlCommandType>().toEqualTypeOf<RunControlCommandType | SupervisorCommandType>();
  expectTypeOf<Extract<SubmitCommandInput, { type: "pause" }>["payload"]>().toEqualTypeOf<PauseCommandPayload | undefined>();
  expectTypeOf<Extract<SubmitCommandInput, { type: "shutdown" }>["payload"]>().toEqualTypeOf<EmptyCommandPayload | undefined>();
  expectTypeOf<Extract<SubmitCommandInput, { type: "signal" }>["payload"]>().toEqualTypeOf<SignalCommandPayload | undefined>();
  expectTypeOf<Extract<SubmitCommandInput, { type: "retry" }>["payload"]>().toEqualTypeOf<RetryCommandPayload | undefined>();
  expectTypeOf<Extract<SubmitCommandInput, { type: "cancel" }>["payload"]>().toEqualTypeOf<CancelCommandPayload | undefined>();
  expectTypeOf<RetryCommandPayload>().toEqualTypeOf<{ target?: string }>();
  expectTypeOf<CancelCommandPayload>().toEqualTypeOf<{ target?: string }>();
  expectTypeOf<SchedulerStoreResult<unknown>>().toEqualTypeOf<Result<unknown, SchedulerStoreError>>();
  expectTypeOf(tryAdvanceRun).toEqualTypeOf<(input: AdvanceRunInput) => ResultAsync<AdvanceRunSummary, AdvanceRunError>>();
  expectTypeOf(tryAdvanceRuntimeRun).toEqualTypeOf<(cwd: string, store: RuntimeStore, runId: string, ownerId?: string, observe?: RuntimeAdvanceObserver) => ResultAsync<RuntimeAdvanceResult, RuntimeAdvanceError>>();
});
