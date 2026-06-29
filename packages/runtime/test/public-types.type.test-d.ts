import { expectTypeOf, test } from "vitest";
import type {
  ForkPreparedWorkflow,
  PreparedRunWorkflow,
  ReplayResult,
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
} from "@acpus/runtime";
import { admitWorkflowRun, getRun, listRuns, mutateRun, normalizeForkInput, normalizeSignalPayload, normalizeWorkflowInput, queueSupervisorShutdown, replayRun, signalRun, startSupervisorLoop } from "@acpus/runtime";
import type { JsonValue, WorkflowIR } from "@acpus/core";

test("@acpus/runtime public types describe use-case level runtime APIs", () => {
  expectTypeOf(admitWorkflowRun).parameters.toEqualTypeOf<[cwd: string, prepared: PreparedRunWorkflow, input: JsonValue]>();
  expectTypeOf(listRuns).toEqualTypeOf<(cwd: string) => Promise<RunRecord[]>>();
  expectTypeOf(getRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<RunDetails | undefined>>();
  expectTypeOf(replayRun).toEqualTypeOf<(cwd: string, runId: string) => Promise<ReplayResult | undefined>>();
  expectTypeOf(queueSupervisorShutdown).toEqualTypeOf<(cwd: string) => Promise<RuntimeCommandRecord | undefined>>();
  expectTypeOf(normalizeForkInput).toEqualTypeOf<(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow) => Promise<JsonValue | undefined>>();
  expectTypeOf(signalRun).toEqualTypeOf<(cwd: string, runId: string, nodeId: string, payload: JsonValue) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(mutateRun).toEqualTypeOf<(cwd: string, runId: string, action: RuntimeMutationAction, input?: RuntimeMutationInput) => Promise<RuntimeMutationResult | undefined>>();
  expectTypeOf(normalizeWorkflowInput).toEqualTypeOf<(ir: WorkflowIR, input: JsonValue, label?: string) => JsonValue>();
  expectTypeOf(normalizeSignalPayload).toEqualTypeOf<(ir: WorkflowIR, nodeId: string, payload: JsonValue) => JsonValue>();
  expectTypeOf(startSupervisorLoop).toEqualTypeOf<(cwd: string, options: SupervisorLoopOptions) => Promise<SupervisorLoopHandle>>();

  expectTypeOf<PreparedRunWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<ForkPreparedWorkflow["lock"]>().toEqualTypeOf<RunWorkflowLockArtifact>();
  expectTypeOf<RunDetails>().toMatchTypeOf<RunRecord>();
  expectTypeOf<RunStatus>().toEqualTypeOf<"pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled">();
});
