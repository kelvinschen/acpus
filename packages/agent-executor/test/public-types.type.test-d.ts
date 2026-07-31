import { expectTypeOf } from "vitest";
import {
  createManagedAcpExecutor,
  type AgentTurnProgress,
  type AgentTurnRequest,
  type AgentTurnResult,
  type ManagedAcpAttempt,
  type ManagedAcpExecutor,
} from "@acpus/agent-executor";

expectTypeOf(createManagedAcpExecutor).returns.resolves.toEqualTypeOf<ManagedAcpExecutor>();
expectTypeOf<ManagedAcpAttempt["runTurn"]>().toEqualTypeOf<(request: AgentTurnRequest) => Promise<AgentTurnResult>>();
expectTypeOf<AgentTurnProgress["responses"]>().toEqualTypeOf<readonly string[]>();

type CompletedTurn = Extract<AgentTurnResult, { status: "completed" }>;
type FailedTurn = Extract<AgentTurnResult, { status: "failed" }>;
type CancelledTurn = Extract<AgentTurnResult, { status: "cancelled" }>;

expectTypeOf<CompletedTurn["finalResponse"]>().toEqualTypeOf<string>();
expectTypeOf<"finalResponse">().not.toMatchTypeOf<keyof FailedTurn>();
expectTypeOf<"finalResponse">().not.toMatchTypeOf<keyof CancelledTurn>();

// @ts-expect-error Turn dispatch belongs to a managed attempt, not a package-level helper.
createManagedAcpExecutor({});
