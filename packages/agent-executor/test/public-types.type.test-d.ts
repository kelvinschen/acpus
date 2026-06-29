import { assertType, expectTypeOf, test } from "vitest";
import type { AgentNodeIR } from "@acpus/core";
import type { AgentExecutionRequest } from "@acpus/agent-executor";
import { executeAgentRequest, getProviderCommandFromEnv } from "@acpus/agent-executor";

declare const agentNode: AgentNodeIR;

test("@acpus/agent-executor public types accept only resolved execution requests", () => {
  assertType<AgentExecutionRequest>({ kind: "mock", prompt: "{}" });
  assertType<AgentExecutionRequest>({
    kind: "command",
    nodeId: "review",
    command: "node worker.js",
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    maxAttempts: 2,
    timeout: "5ms",
    acceptOutput: output => output,
  });
  expectTypeOf(executeAgentRequest).toEqualTypeOf<(request: AgentExecutionRequest) => Promise<unknown>>();
  expectTypeOf(getProviderCommandFromEnv).toEqualTypeOf<(use: string, env?: NodeJS.ProcessEnv) => string | undefined>();

  assertType<AgentExecutionRequest>({
    kind: "command",
    nodeId: "review",
    command: "node worker.js",
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    maxAttempts: 1,
    // @ts-expect-error resolved agent execution must not accept runtime scheduler scope.
    scope: { input: {} },
  });

  // @ts-expect-error resolved agent execution must not accept scheduler node arguments.
  executeAgentRequest(agentNode, { input: {} });
});
