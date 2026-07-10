import { describe, expect, it } from "vitest";
import type { EvaluationScope } from "../src/evaluation/evaluator.js";
import { scopeWithFanoutItem, scopeWithLoopIteration, scopeWithNodeOutput } from "../src/scheduler/scope.js";

function populatedScope(): EvaluationScope {
  return {
    input: { request: "original" },
    meta: { runId: "run_1" },
    nodes: { existing: { status: "completed", output: { ok: true } } },
    fanout: { existing: { item: "old", itemIndex: 0 } },
    loop: { existing: { index: 0, round: 1, state: "old" } },
  };
}

describe("scheduler scope bindings", () => {
  it("adds a completed node with undefined output without mutating other bindings", () => {
    const scope = populatedScope();
    const before = structuredClone(scope);

    const result = scopeWithNodeOutput(scope, "next", undefined);

    expect(scope).toEqual(before);
    expect(result).not.toBe(scope);
    expect(result.nodes).not.toBe(scope.nodes);
    expect(result.nodes).toEqual({
      existing: { status: "completed", output: { ok: true } },
      next: { status: "completed", output: undefined },
    });
    expect(result.nodes?.next).toHaveProperty("output", undefined);
    expect(result.input).toBe(scope.input);
    expect(result.meta).toBe(scope.meta);
    expect(result.fanout).toBe(scope.fanout);
    expect(result.loop).toBe(scope.loop);
  });

  it("adds a fanout item without mutating or replacing unrelated bindings", () => {
    const scope = populatedScope();
    const before = structuredClone(scope);

    const result = scopeWithFanoutItem(scope, "items", { id: "item_3" }, 3);

    expect(scope).toEqual(before);
    expect(result.fanout).toEqual({
      existing: { item: "old", itemIndex: 0 },
      items: { item: { id: "item_3" }, itemIndex: 3 },
    });
    expect(result.input).toBe(scope.input);
    expect(result.meta).toBe(scope.meta);
    expect(result.nodes).toBe(scope.nodes);
    expect(result.loop).toBe(scope.loop);
  });

  it("uses zero-based loop index, one-based round, and omits absent state", () => {
    const scope = populatedScope();
    const before = structuredClone(scope);

    const withoutState = scopeWithLoopIteration(scope, "repeat", 2);
    const withState = scopeWithLoopIteration(scope, "repeat", 2, null);

    expect(scope).toEqual(before);
    expect(withoutState.loop).toEqual({
      existing: { index: 0, round: 1, state: "old" },
      repeat: { index: 2, round: 3 },
    });
    expect(withoutState.loop?.repeat).not.toHaveProperty("state");
    expect(withState.loop?.repeat).toEqual({ index: 2, round: 3, state: null });
    expect(withoutState.input).toBe(scope.input);
    expect(withoutState.meta).toBe(scope.meta);
    expect(withoutState.nodes).toBe(scope.nodes);
    expect(withoutState.fanout).toBe(scope.fanout);
  });
});
