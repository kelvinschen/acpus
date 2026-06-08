import { describe, it, expect } from "vitest";
import { StubAgentExecutor } from "./stub-agent.js";
import type { StubAgentResponse } from "./stub-agent.js";
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

describe("StubAgentExecutor", () => {
  it("returns stub output for configured step", async () => {
    const executor = new StubAgentExecutor({
      "test-step": { output: { result: "done" } }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.output).toEqual({ result: "done" });
    expect(result.error).toBeUndefined();
  });

  it("returns error for unconfigured step", async () => {
    const executor = new StubAgentExecutor({});
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.error).toContain("No stub response");
  });

  it("returns partial result on abort signal", async () => {
    const executor = new StubAgentExecutor({
      "test-step": { output: { partial: true }, delay: 1000 }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    const result = await executor.execute({ node, context: baseCtx(), signal: controller.signal, nodeKey: node.id });
    expect(result.partial).toBe(true);
  });

  it("simulates a classified failure via failureKind", async () => {
    const executor = new StubAgentExecutor({
      "test-step": { failureKind: "schema", output: { bad: true } }
    });
    const node = makeAgentNode({ prompt: "Score it" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("schema");
    expect(result.error).toContain("Simulated schema failure");
  });

  it("advances through a sequence of responses on successive calls", async () => {
    const executor = new StubAgentExecutor({
      "test-step": {
        sequence: [
          { failureKind: "parse" as const, error: "bad json" },
          { output: { ok: true } }
        ]
      }
    });
    const node = makeAgentNode({ prompt: "Try me" });
    const signal = new AbortController().signal;

    // First call → parse failure
    const r1 = await executor.execute({ node, context: baseCtx(), signal, nodeKey: node.id });
    expect(r1.failureKind).toBe("parse");

    // Second call → success
    const r2 = await executor.execute({ node, context: baseCtx(), signal, nodeKey: node.id });
    expect(r2.output).toEqual({ ok: true });

    // Third call → still returns last element
    const r3 = await executor.execute({ node, context: baseCtx(), signal, nodeKey: node.id });
    expect(r3.output).toEqual({ ok: true });
  });

  it("respects delay and detects abort after delay", async () => {
    const executor = new StubAgentExecutor({
      "test-step": { output: { result: "done" }, delay: 200 }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const controller = new AbortController();

    // Abort after a short delay (before the 200ms delay completes)
    setTimeout(() => controller.abort(), 50);

    const result = await executor.execute({ node, context: baseCtx(), signal: controller.signal, nodeKey: node.id });
    expect(result.partial).toBe(true);
  });
});
