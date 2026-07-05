import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import type { NodeExecutionState } from "../../src/types.js";

const fixtures = join(import.meta.dirname, "../fixtures/program-composite-workflows");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

function byId(nodes: NodeExecutionState[], id: string): NodeExecutionState[] {
  return nodes.filter((node) => node.nodeId === id);
}

function one(nodes: NodeExecutionState[], id: string): NodeExecutionState {
  const matches = byId(nodes, id);
  expect(matches, `Expected exactly one node with id ${id}`).toHaveLength(1);
  return matches[0]!;
}

describe("Program-only composite workflow fixtures", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
    cleanups.length = 0;
  });

  it("executes fanout -> parallel -> switch and preserves intermediate outputs", async () => {
    const ir = compileYaml(fixture("fanout-parallel-switch.workflow.yaml"));
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealProgramExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["alpha", "beta"], mode: "check" } });
    const finalMeta = store.readRunMeta(meta.runId);
    const nodes = store.listNodeStates(meta.runId);

    expect(finalMeta?.status).toBe("completed");
    expect(finalMeta?.output).toEqual({
      count: 2,
      routes: ["alpha", "default"],
      uppers: ["ALPHA", "BETA"]
    });

    expect(one(nodes, "summarize").output).toEqual({
      output: { lane_count: 2, routes: ["alpha", "default"], uppers: ["ALPHA", "BETA"] },
      exit_code: 0
    });
    expect(one(nodes, "mapped").output).toEqual({
      output: [
        { upper: { item: "alpha", upper: "ALPHA" }, routed: { route: "alpha", item: "alpha" } },
        { upper: { item: "beta", upper: "BETA" }, routed: { route: "default", item: "beta" } }
      ]
    });

    const perItem = byId(nodes, "per_item").sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    expect(perItem).toHaveLength(2);
    expect(perItem.map((node) => node.output)).toEqual([
      { output: { upper: { item: "alpha", upper: "ALPHA" }, routed: { route: "alpha", item: "alpha" } } },
      { output: { upper: { item: "beta", upper: "BETA" }, routed: { route: "default", item: "beta" } } }
    ]);

    expect(byId(nodes, "alpha_route")).toHaveLength(1);
    expect(byId(nodes, "default_route")).toHaveLength(1);

    const leafKeys = byId(nodes, "upper_value").map((node) => node.nodeKey).sort();
    expect(leafKeys).toEqual([
      "workflow/mapped/$do/per_item/$upper/upper_value/item:alpha/lane:0/branch:upper",
      "workflow/mapped/$do/per_item/$upper/upper_value/item:beta/lane:1/branch:upper"
    ]);
  });

  it("executes explicit pipeline with loop and switch projection", async () => {
    const ir = compileYaml(fixture("pipeline-loop-switch.workflow.yaml"));
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealProgramExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { mode: "double" } });
    const finalMeta = store.readRunMeta(meta.runId);
    const nodes = store.listNodeStates(meta.runId);

    expect(finalMeta?.status).toBe("completed");
    expect(finalMeta?.output).toEqual({ final_value: 8, selected_mode: "double", loop_iter: 2 });

    expect(byId(nodes, "tick").map((node) => node.output)).toEqual([
      { output: { iter: 0, value: 2 }, exit_code: 0 },
      { output: { iter: 1, value: 3 }, exit_code: 0 },
      { output: { iter: 2, value: 4 }, exit_code: 0 }
    ]);
    expect(one(nodes, "iterate").output).toEqual({ output: { iter: 2, value: 4 } });
    expect(byId(nodes, "keep_it")).toEqual([]);
    expect(one(nodes, "choose").output).toEqual({ output: { mode: "double", value: 8 } });
    expect(one(nodes, "build").output).toEqual({
      output: { seed: 2, iter: 2, selected_mode: "double", final_value: 8 }
    });

    expect(byId(nodes, "tick").map((node) => node.nodeKey)).toEqual([
      "workflow/build/iterate/$do/tick/round:0",
      "workflow/build/iterate/$do/tick/round:1",
      "workflow/build/iterate/$do/tick/round:2"
    ]);
  });
});
