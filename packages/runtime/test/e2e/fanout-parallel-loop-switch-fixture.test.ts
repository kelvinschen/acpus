import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileWorkflow } from "@acpus/core";
import { buildRenderTree, buildRows } from "../../../tui/src/model.js";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

const fixtures = join(import.meta.dirname, "../../../core/test/fixtures");
const fixturePath = join(fixtures, "fanout-parallel-loop-switch-tui/workflow.yaml");

describe("E2E: fanout/parallel/loop/switch TUI fixture", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes the nested mock workflow with default input values", async () => {
    const source = readFileSync(fixturePath, "utf8");
    const compiled = compileWorkflow(source, { sourcePath: fixturePath });
    expect(compiled.ok).toBe(true);
    const ir = compiled.ir!;

    const { interpreter, store, cleanup } = createTestInterpreter();
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const storedInput = store.readInput(meta.runId);
    expect(storedInput).toEqual({ lanes: ["alpha", "beta", "gamma"], max_rounds: 3, route_mode: "default" });

    const nodes = store.listNodeStates(meta.runId);
    const fanout = nodes.find((n) => n.nodeId === "fanout_parallel_loop_switch");
    expect(fanout?.state).toBe("completed");
    expect(fanout?.output).toHaveLength(3);

    const laneParallel = nodes.filter((n) => n.nodeId === "lane_parallel");
    expect(laneParallel).toHaveLength(3);

    const reviewNodes = nodes.filter((n) => n.nodeId === "review_lane");
    expect(reviewNodes).toHaveLength(3);
    for (const n of reviewNodes) {
      expect(n.nodeKey).toMatch(/item:(alpha|beta|gamma)/);
      expect(n.nodeKey).toMatch(/lane:[012]/);
      expect(n.nodeKey).toMatch(/branch:0/);
      expect(n.output).toEqual({ output: { branch: "review", lane: "fixture", ok: true } });
    }

    const loopNodes = nodes.filter((n) => n.nodeId === "loop_agent");
    expect(loopNodes).toHaveLength(9);
    for (const n of loopNodes) {
      expect(n.nodeKey).toMatch(/lane:[012]/);
      expect(n.nodeKey).toMatch(/branch:1/);
      expect(n.nodeKey).toMatch(/round:[012]/);
    }

    const switchAlpha = nodes.filter((n) => n.nodeId === "switch_alpha_agent");
    const switchDefault = nodes.filter((n) => n.nodeId === "switch_default_agent");
    const switchFallback = nodes.filter((n) => n.nodeId === "switch_fallback_agent");
    expect(switchAlpha).toHaveLength(1);
    expect(switchAlpha[0]?.nodeKey).toContain("item:alpha");
    expect(switchDefault).toHaveLength(2);
    expect(switchFallback).toHaveLength(0);

    const rows = buildRows(buildRenderTree(ir, nodes));
    expect(rows.find((r) => r.irNode.id === "fanout_parallel_loop_switch")?.label).toContain("×3");
    expect(rows.filter((r) => r.groupDim === "lane").map((r) => r.label)).toEqual([
      "lane=0 «alpha»",
      "lane=1 «beta»",
      "lane=2 «gamma»"
    ]);
    expect(rows.filter((r) => r.groupDim === "round")).toHaveLength(9);
  });

  it("can force the switch default branch through explicit input", async () => {
    const ir = compileYaml(readFileSync(fixturePath, "utf8"));
    const { interpreter, store, cleanup } = createTestInterpreter();
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { route_mode: "fallback" } });
    expect(meta.status).toBe("completed");
    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.filter((n) => n.nodeId === "switch_alpha_agent")).toHaveLength(1);
    expect(nodes.filter((n) => n.nodeId === "switch_default_agent")).toHaveLength(0);
    expect(nodes.filter((n) => n.nodeId === "switch_fallback_agent")).toHaveLength(2);
  });
});
