import { expectTypeOf, test } from "vitest";
import type {
  ForkPreparedWorkflow,
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
  RunStatus,
  RunWorkflowLockArtifact,
  RuntimeCommandRecord,
  RuntimeMutationAction,
  RuntimeMutationInput,
  RuntimeMutationResult,
  SupervisorLoopHandle,
  SupervisorLoopOptions,
  WorkflowVisualizationGroup,
  WorkflowVisualizationNode,
  WorkflowVisualizationOverlay,
} from "@acpus/runtime";
import { admitWorkflowRun, createWorkflowVisualizationOverlay, getRun, getRunVisualizationOverlay, listRuns, mutateRun, normalizeForkInput, normalizeSignalPayload, normalizeWorkflowInput, queueSupervisorShutdown, replayRun, signalRun, startSupervisorLoop } from "@acpus/runtime";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";

test("@acpus/runtime public types describe use-case level runtime APIs", () => {
  expectTypeOf(admitWorkflowRun).parameters.toEqualTypeOf<[cwd: string, prepared: PreparedRunWorkflow, input: JsonValue]>();
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(getRunVisualizationOverlay).toEqualTypeOf<(cwd: string, runId: string) => Promise<WorkflowVisualizationOverlay | undefined>>();
  expectTypeOf(replayRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<ReplayResult | undefined>>();
  expectTypeOf(queueSupervisorShutdown).toEqualTypeOf<(cwd: string) => Promise<RuntimeCommandRecord | undefined>>();
  expectTypeOf(normalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => Promise<JsonValue | undefined>>();
  expectTypeOf(signalRun).toEqualTypeOf<(cwd: string, runId: string, nodeId: string, payload: JsonValue) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(mutateRun).toEqualTypeOf<(cwd: string, runId: string, action: RuntimeMutationAction, input?: RuntimeMutationInput) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(normalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => JsonValue>();
  expectTypeOf(normalizeSignalPayload).toEqualTypeOf<(ir: WorkflowIR, nodeId: string, payload: JsonValue) => JsonValue>();
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
  expectTypeOf<WorkflowVisualizationOverlay["nodes"][number]>().toEqualTypeOf<WorkflowVisualizationNode>();
  expectTypeOf<WorkflowVisualizationOverlay["groups"][number]>().toEqualTypeOf<WorkflowVisualizationGroup>();
  expectTypeOf<RunStatus>().toEqualTypeOf<"pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled">();
});
