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
import { openRuntimeStore } from "../../src/store/store.js";
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
  input: AdvanceFrozenRunInput & {
    executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  },
) {
  const { executeAgentTurn, ...productionInput } = input;
  return advanceFrozenRunProduction({
    ...productionInput,
    agentSessionSupervisor: testAgentSessionSupervisor(executeAgentTurn),
  });
}

export async function forkRuntimeRun(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  options?: Parameters<Awaited<ReturnType<typeof openRuntimeStore>>["forkRun"]>[1],
) {
  const result = await store.forkRun(runId, options);
  if (result.isErr()) throw Object.assign(new Error(result.error.message), { failure: result.error });
  return result.value;
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
