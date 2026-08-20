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

expectTypeOf(createAgentSessionSupervisor).returns.resolves.toMatchTypeOf<
  import("neverthrow").Result<AgentSessionSupervisor, unknown>
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

createAgentSessionSupervisor({
  workersRoot: "/tmp/workers",
  sessionStateDirectoryForRun: runId => `/tmp/runs/${runId}`,
  owner: { epoch: 1, pid: process.pid },
});

// @ts-expect-error owner identity requires the Runtime epoch and pid.
createAgentSessionSupervisor({ workersRoot: "/tmp/workers", sessionStateDirectoryForRun: () => "/tmp/run", owner: {} });
