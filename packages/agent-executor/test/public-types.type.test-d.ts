import { expectTypeOf } from "vitest";
import {
  createAgentSessionSupervisor,
  type AcpOwnershipManifest,
  type AgentSessionSupervisor,
  type AgentSessionSupervisorOptions,
  type AgentSessionLease,
  type ConfiguredAcpAgentCommandResolver,
  type TurnInput,
} from "@acpus/agent-executor";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { makeNodeProcessHost } from "@acpus/owned-process";

expectTypeOf(createAgentSessionSupervisor).returns.toMatchTypeOf<
  Effect.Effect<AgentSessionSupervisor, unknown, Scope.Scope>
>();
expectTypeOf<AcpOwnershipManifest["schemaVersion"]>().toEqualTypeOf<3>();
expectTypeOf<"owner">().toMatchTypeOf<keyof AgentSessionSupervisorOptions>();
expectTypeOf<"withAttempt">().not.toMatchTypeOf<keyof AgentSessionSupervisor>();
expectTypeOf<"interrupt">().not.toMatchTypeOf<keyof AgentSessionSupervisor>();
expectTypeOf<"steer">().not.toMatchTypeOf<keyof AgentSessionSupervisor>();
expectTypeOf<AgentSessionLease["runTurn"]>().parameters.toEqualTypeOf<[TurnInput<unknown>]>();
expectTypeOf<AgentSessionLease["reportedVersion"]>().toEqualTypeOf<string | undefined>();
expectTypeOf<"onEvent">().toMatchTypeOf<keyof TurnInput<unknown>>();
expectTypeOf<"onObservation">().not.toMatchTypeOf<keyof TurnInput<unknown>>();
expectTypeOf<"configuredAgentCommand">().toMatchTypeOf<keyof AgentSessionSupervisorOptions>();
expectTypeOf<ConfiguredAcpAgentCommandResolver>().parameter(0).toEqualTypeOf<readonly string[]>();
expectTypeOf<ConfiguredAcpAgentCommandResolver>().returns.toMatchTypeOf<
  Effect.Effect<string | undefined, unknown>
>();

createAgentSessionSupervisor({
  workersRoot: "/tmp/workers",
  sessionStateDirectoryForRun: runId => `/tmp/runs/${runId}`,
  owner: { epoch: 1, pid: process.pid },
}, makeNodeProcessHost());

// @ts-expect-error owner identity requires the Runtime epoch and pid.
createAgentSessionSupervisor({ workersRoot: "/tmp/workers", sessionStateDirectoryForRun: () => "/tmp/run", owner: {} }, makeNodeProcessHost());
