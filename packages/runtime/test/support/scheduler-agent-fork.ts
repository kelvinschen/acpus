import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { makeNodeProcessHost } from "@acpus/owned-process";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type {
  FixtureAgentTurnRequest as AgentTurnRequest,
  FixtureAgentTurnResult as AgentTurnResult,
} from "./agent-turn.js";
import { defineWorkflow, z } from "@acpus/core";
import { template } from "@acpus/expression";
import { vi } from "vitest";
import {
  advanceFrozenRun as advanceFrozenRunProduction,
  type AdvanceFrozenRunInput,
} from "../../src/scheduler/runtime-runner.js";
import { openRuntimeStoreAdapter } from "../../src/store/store.js";
import { createInlineTaskAttemptHarness, type TaskAttemptRunner } from "./task-attempt-harness.js";
import { testAgentSessionSupervisor as createTestAgentSessionSupervisor } from "./agent-session-supervisor.js";

const executorMocks = vi.hoisted(() => ({
  runTaskAttempt: vi.fn<TaskAttemptRunner>(),
}));

vi.mock("../../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/execution/task-process.js")>(),
  runTaskAttempt: executorMocks.runTaskAttempt,
}));

const taskAttemptHarness = createInlineTaskAttemptHarness();
executorMocks.runTaskAttempt.mockImplementation(input => taskAttemptHarness.runAttempt(input));

export function advanceFrozenRun(
  input: Omit<AdvanceFrozenRunInput, "processes"> & Partial<Pick<AdvanceFrozenRunInput, "processes">> & {
    executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  },
) {
  const { executeAgentTurn, ...productionInput } = input;
  return Effect.runPromise(advanceFrozenRunProduction({
    ...productionInput,
    processes: productionInput.processes ?? makeNodeProcessHost(),
    agentSessionSupervisor: testAgentSessionSupervisor(executeAgentTurn),
  }));
}

export function interruptFrozenRunWhen(
  input: Parameters<typeof advanceFrozenRun>[0],
  shouldInterrupt: () => boolean,
) {
  const reached = Deferred.makeUnsafe<void>();
  const { executeAgentTurn, ...productionInput } = input;
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(advanceFrozenRunProduction({
      ...productionInput,
      processes: productionInput.processes ?? makeNodeProcessHost(),
      agentSessionSupervisor: testAgentSessionSupervisor(executeAgentTurn),
      onCheckpoint: () => shouldInterrupt()
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void,
    }));
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(fiber);
  })));
}

export async function forkRuntimeRun(
  store: Awaited<ReturnType<typeof openRuntimeStoreAdapter>>,
  runId: string,
  options?: Parameters<Awaited<ReturnType<typeof openRuntimeStoreAdapter>>["forkRun"]>[1],
) {
  const result = await Effect.runPromise(Effect.result(store.forkRun(runId, options)));
  if (Result.isFailure(result)) {
    throw Object.assign(new Error(result.failure.message), { failure: result.failure });
  }
  return result.success;
}

export function injectedAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-injection",
    description: "Review a change with configured agents.",
    agents: {
      reviewer: {
        use: "codex",
        model: "old-model",
        permissionMode: "approve-reads",
        config: { mode: "agent" },
      },
      auditor: { use: "claude" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: "review",
    });
    return {};
  });
}

export function forkAgentWorkflow(sessionKey?: string) {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-agent-session",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    const first = step("first_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: "review",
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
    step("second_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: template`review again: ${first.output.ok}`,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
    return {};
  });
}

export function targetedForkFailedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-source",
  }).build(({ step }) => {
    const first = step("first").task({
      input: null,
      exec: async () => ({ ok: true }),
    });
    step("boom").task({
      input: first.output.ok,
      exec: async () => {
        throw new Error("boom");
      },
    });
    return {};
  });
}

export function targetedForkReplacementWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-replacement",
  }).build(({ step }) => {
    const first = step("first").task({
      input: null,
      exec: async () => ({ ok: true }),
    });
    const fixed = step("fixed").task({
      input: { ok: first.output.ok },
      exec: async ({ input }) => ({ ok: input.ok }),
    });
    return { ok: fixed.output.ok };
  });
}

export function targetedForkCompletedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-completed",
  }).build(({ step }) => {
    const first = step("first").task({
      input: null,
      exec: async () => ({ ok: true }),
    });
    const second = step("second").task({
      input: { ok: first.output.ok },
      exec: async ({ input }) => ({ ok: input.ok }),
    });
    return { ok: second.output.ok };
  });
}

function testAgentSessionSupervisor(
  executeAgentTurn: ((request: AgentTurnRequest) => Promise<AgentTurnResult>) | undefined,
): AgentSessionSupervisor {
  return createTestAgentSessionSupervisor(executeAgentTurn ?? (async request => {
    throw new Error(`Unexpected Agent execution for '${request.agentSessionId}'.`);
  }));
}
