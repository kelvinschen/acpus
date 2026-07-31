import { expectTypeOf } from "vitest";
import {
  createManagedAcpExecutor,
  type AgentTurnRequest,
  type AgentTurnResult,
  type ManagedAcpAttempt,
  type ManagedAcpExecutor,
} from "@acpus/agent-executor";

expectTypeOf(createManagedAcpExecutor).returns.resolves.toEqualTypeOf<ManagedAcpExecutor>();
expectTypeOf<ManagedAcpAttempt["runTurn"]>().toEqualTypeOf<(request: AgentTurnRequest) => Promise<AgentTurnResult>>();

// @ts-expect-error Turn dispatch belongs to a managed attempt, not a package-level helper.
createManagedAcpExecutor({});
