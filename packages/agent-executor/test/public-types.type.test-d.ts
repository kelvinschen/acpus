import { expectTypeOf } from "vitest";
import {
  createManagedAcpExecutor,
  type AcpOwnershipManifest,
  type AgentBackendFailure,
  type AgentTurnSummary,
  type AgentTurnProgress,
  type AgentTurnRequest,
  type AgentTurnResult,
  type ManagedAcpAttempt,
  type ManagedAcpAttemptInput,
  type ManagedAcpExecutor,
  type ManagedAcpExecutorOptions,
} from "@acpus/agent-executor";

expectTypeOf(createManagedAcpExecutor).returns.resolves.toEqualTypeOf<ManagedAcpExecutor>();
expectTypeOf<ManagedAcpAttempt["runTurn"]>().toEqualTypeOf<(request: AgentTurnRequest) => Promise<AgentTurnResult>>();
expectTypeOf<ManagedAcpAttemptInput["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
expectTypeOf<AgentTurnProgress["responses"]>().toEqualTypeOf<readonly string[]>();
expectTypeOf<"owner">().toMatchTypeOf<keyof ManagedAcpExecutorOptions>();
expectTypeOf<"daemon">().not.toMatchTypeOf<keyof ManagedAcpExecutorOptions>();
expectTypeOf<AcpOwnershipManifest["schemaVersion"]>().toEqualTypeOf<2>();
expectTypeOf<"owner">().toMatchTypeOf<keyof AcpOwnershipManifest>();
expectTypeOf<"daemon">().not.toMatchTypeOf<keyof AcpOwnershipManifest>();
expectTypeOf<NonNullable<AgentBackendFailure["upstream"]>["source"]>()
  .toEqualTypeOf<"acp">();
expectTypeOf<NonNullable<AgentBackendFailure["upstream"]>["operation"]>()
  .toEqualTypeOf<"open_session" | "configure_session" | "run_turn">();
expectTypeOf<AgentTurnSummary["sessionProjectionPath"]>()
  .toEqualTypeOf<string | undefined>();
expectTypeOf<"providerRecordId">().not.toMatchTypeOf<keyof AgentTurnSummary>();

createManagedAcpExecutor({
  workersRoot: "/tmp/workers",
  sessionStateDirectoryForRun: runId => `/tmp/runs/${runId}`,
  owner: { generation: 1 },
});

type CompletedTurn = Extract<AgentTurnResult, { status: "completed" }>;
type FailedTurn = Extract<AgentTurnResult, { status: "failed" }>;
type CancelledTurn = Extract<AgentTurnResult, { status: "cancelled" }>;

expectTypeOf<CompletedTurn["finalResponse"]>().toEqualTypeOf<string>();
expectTypeOf<"finalResponse">().not.toMatchTypeOf<keyof FailedTurn>();
expectTypeOf<"finalResponse">().not.toMatchTypeOf<keyof CancelledTurn>();

// @ts-expect-error Turn dispatch belongs to a managed attempt, not a package-level helper.
createManagedAcpExecutor({});
