import { describe, it, expect } from "vitest";
import { MockAgentExecutor } from "../../src/executors/mock-agent.js";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext } from "../../src/types.js";

function makeAgentNode(metadata: Record<string, unknown>): IrNode {
  return {
    id: "test-step",
    kind: "run.agent",
    nodePath: ["workflow", "test-step"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/test-step" },
    metadata
  };
}

function baseCtx(): ExpressionContext {
  return { input: {}, steps: {}, run_id: "test" };
}

describe("MockAgentExecutor", () => {
  it("returns mock output for configured step", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { result: "done" } }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.output).toEqual({ result: "done" });
    expect(result.error).toBeUndefined();
  });

  it("returns error for unconfigured step", async () => {
    const executor = new MockAgentExecutor({});
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.error).toContain("No mock response");
  });

  it("returns partial result on abort signal", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { partial: true }, delay: 1000 }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    const result = await executor.execute(node, baseCtx(), controller.signal);
    expect(result.partial).toBe(true);
  });

  it("validates output against schema", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { score: 8 } }
    });
    const node = makeAgentNode({
      prompt: "Score it",
      output: {
        type: "object",
        properties: {
          score: { type: "number" }
        },
        required: ["score"]
      }
    });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);
    expect(result.output).toEqual({ score: 8 });
  });
});
