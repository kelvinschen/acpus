import { describe, it, expect } from "vitest";
import type { AcpusIr, IrNode } from "@acpus/core";
import type { NodeExecutionState } from "@acpus/runtime";
import {
  buildRenderTree,
  buildRows,
  countByState,
  aggregateState,
  indexByNodeId,
  parseNodeKey,
  formatDuration,
  formatElapsed
} from "../src/model.js";
import { visibleRows } from "../src/components/App.js";

function node(id: string, kind: IrNode["kind"], extra: Partial<IrNode> = {}): IrNode {
  return {
    id,
    kind,
    nodePath: ["workflow", id],
    keyTemplate: { astVersion: 1, nodePath: `workflow/${id}` },
    metadata: {},
    ...extra
  };
}

function state(
  nodeId: string,
  nodeKey: string,
  s: NodeExecutionState["state"],
  attempt = 1,
  kind: NodeExecutionState["kind"] = "run.agent"
): NodeExecutionState {
  return { nodeKey, nodeId, kind, state: s, attempt };
}

function ir(root: IrNode): AcpusIr {
  return {
    irVersion: 1,
    astVersion: 1,
    source: { digest: "x" },
    name: "test",
    input: {},
    agents: {},
    root,
    outputs: {},
    expressions: []
  };
}

describe("model overlay", () => {
  it("builds a tree overlaying states onto a pipeline", () => {
    const root = node("workflow", "pipeline", {
      children: [node("a", "run.agent"), node("b", "run.program")]
    });
    const states = [
      state("workflow", "workflow", "running", 1, "pipeline"),
      state("a", "workflow/a", "completed"),
      state("b", "workflow/b", "running")
    ];
    const tree = buildRenderTree(ir(root), states);
    expect(tree.irNode.id).toBe("workflow");
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].instances[0].state).toBe("completed");
    expect(tree.children[1].instances[0].state).toBe("running");
  });

  it("expands fanout into per-lane groups; (×N) only on the fanout", () => {
    const fan = node("mapped", "fanout", { children: [node("work", "run.agent")] });
    const root = node("workflow", "pipeline", { children: [fan] });
    const states = [
      state("work", "workflow/mapped/work/item:a/lane:0", "completed"),
      state("work", "workflow/mapped/work/item:b/lane:1", "running")
    ];
    const idx = indexByNodeId(states);
    expect(idx.get("work")).toHaveLength(2);

    const rows = buildRows(buildRenderTree(ir(root), states));

    // (×N) lives only on the fanout node.
    const mapped = rows.find((r) => r.irNode.id === "mapped");
    expect(mapped?.label).toContain("×2");

    // Two synthetic lane group rows, labeled "lane=N [item]".
    const groups = rows.filter((r) => r.groupDim === "lane");
    expect(groups.map((g) => g.label)).toEqual(["lane=0 [a]", "lane=1 [b]"]);
    expect(groups.map((g) => g.groupItem)).toEqual(["a", "b"]);

    // The work node appears once per lane, each a single instance, no "×".
    const workRows = rows.filter((r) => r.irNode.id === "work");
    expect(workRows).toHaveLength(2);
    for (const w of workRows) {
      expect(w.label).toBe("work");
      expect(w.instance).toBeDefined();
    }
  });

  it("does not mark parallel children with (×N) under a fanout", () => {
    const par = node("review", "parallel", {
      children: [node("sec", "run.agent"), node("perf", "run.agent")]
    });
    const fan = node("mapped", "fanout", { children: [par] });
    const root = node("workflow", "pipeline", { children: [fan] });
    const states = [
      state("sec", "workflow/mapped/review/sec/item:a/lane:0/branch:0", "failed"),
      state("perf", "workflow/mapped/review/perf/item:a/lane:0/branch:1", "failed"),
      state("sec", "workflow/mapped/review/sec/item:b/lane:1/branch:0", "failed"),
      state("perf", "workflow/mapped/review/perf/item:b/lane:1/branch:1", "failed")
    ];
    const rows = buildRows(buildRenderTree(ir(root), states));

    // Only the fanout shows a count.
    expect(rows.filter((r) => r.label.includes("×"))).toHaveLength(1);
    expect(rows.find((r) => r.label.includes("×"))?.irNode.id).toBe("mapped");

    // sec/perf appear once per lane, single instance each.
    expect(rows.filter((r) => r.irNode.id === "sec")).toHaveLength(2);
    expect(rows.filter((r) => r.irNode.id === "perf")).toHaveLength(2);
  });

  it("emits globally-unique rowKeys for the same composite under multiple fanout lanes", () => {
    // A LOOP nested under a FANOUT: each lane expands the loop into its own
    // round group rows. The rowKey of those group rows MUST be unique across
    // lanes (otherwise React/Ink emits "two children with the same key" and
    // re-renders go haywire — the bug that caused screen flicker).
    const loop = node("loop_lane", "loop", { children: [node("body", "run.agent")] });
    const fan = node("mapped", "fanout", { children: [loop] });
    const root = node("workflow", "pipeline", { children: [fan] });
    const states = [
      state("body", "workflow/mapped/loop_lane/body/item:a/lane:0/round:0", "completed"),
      state("body", "workflow/mapped/loop_lane/body/item:a/lane:0/round:1", "completed"),
      state("body", "workflow/mapped/loop_lane/body/item:b/lane:1/round:0", "completed"),
      state("body", "workflow/mapped/loop_lane/body/item:b/lane:1/round:1", "completed")
    ];
    const rows = buildRows(buildRenderTree(ir(root), states));
    const keys = rows.map((r) => r.rowKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Concretely: round=1 should appear under each lane with distinct rowKeys.
    const round1Rows = rows.filter((r) => r.groupDim === "round" && r.groupValue === "1");
    expect(round1Rows).toHaveLength(2);
    expect(round1Rows[0].rowKey).not.toBe(round1Rows[1].rowKey);
  });

  it("derives switch branch labels and predicates", () => {
    const sw = node("decide", "switch", {
      branches: [
        { id: "case_1", when: "x > 1", children: [node("hot", "run.agent")] },
        { id: "default", children: [node("cold", "run.agent")] }
      ]
    });
    const root = node("workflow", "pipeline", { children: [sw] });
    const rows = buildRows(buildRenderTree(ir(root), []));
    const hot = rows.find((r) => r.irNode.id === "hot");
    expect(hot?.branchLabel).toBe("case_1");
    expect(hot?.branchWhen).toBe("x > 1");
  });

  it("aggregates multi-instance state with failure precedence", () => {
    const fan = node("mapped", "fanout", { children: [node("work", "run.agent")] });
    const root = node("workflow", "pipeline", { children: [fan] });
    const states = [
      state("work", "workflow/mapped/work/item:a/lane:0", "completed"),
      state("work", "workflow/mapped/work/item:b/lane:1", "failed")
    ];
    const tree = buildRenderTree(ir(root), states);
    // The fanout node aggregates the states of all its lanes.
    const fanoutNode = tree.children[0];
    expect(fanoutNode.irNode.id).toBe("mapped");
    expect(aggregateState(fanoutNode)).toBe("failed");
  });

  it("parses node keys into path and dynamic dims", () => {
    const p = parseNodeKey("workflow/mapped/work/item:file-a/lane:0/branch:1/round:2");
    expect(p.path).toEqual(["workflow", "mapped", "work"]);
    expect(p.dims.get("item")).toBe("file-a");
    expect(p.dims.get("lane")).toBe("0");
    expect(p.dims.get("branch")).toBe("1");
    expect(p.dims.get("round")).toBe("2");
  });

  it("expands loop rounds with numeric ordering; (×N) on the loop", () => {
    const loop = node("iter", "loop", { children: [node("body", "run.agent")] });
    const root = node("workflow", "pipeline", { children: [loop] });
    const states = [
      state("body", "workflow/iter/body/round:0", "completed"),
      state("body", "workflow/iter/body/round:2", "completed"),
      state("body", "workflow/iter/body/round:10", "running")
    ];
    const rows = buildRows(buildRenderTree(ir(root), states));
    const loopRow = rows.find((r) => r.irNode.id === "iter");
    expect(loopRow?.label).toContain("×3");
    const groups = rows.filter((r) => r.groupDim === "round");
    expect(groups.map((g) => g.label)).toEqual(["round=0", "round=2", "round=10"]);
  });

  it("computes tree guide-line prefixes (├─/└─/│)", () => {
    const root = node("workflow", "pipeline", {
      children: [node("a", "run.agent"), node("b", "run.agent"), node("c", "run.agent")]
    });
    const rows = buildRows(buildRenderTree(ir(root), []));
    const byId = (id: string) => rows.find((r) => r.irNode.id === id);
    const prefix = (id: string) => byId(id)?.treeSegments.map((s) => s.text).join("") ?? "";
    // Root has no prefix.
    expect(prefix("workflow")).toBe("");
    // First two children are non-last → "├─ ", last child → "└─ ".
    expect(prefix("a")).toBe("├─ ");
    expect(prefix("b")).toBe("├─ ");
    expect(prefix("c")).toBe("└─ ");
    // pipeline children inherit the pipeline guide-line color.
    expect(byId("a")?.treeSegments.every((s) => s.ownerKind === "pipeline")).toBe(true);
  });

  it("draws continuation columns for deeper non-last ancestors", () => {
    // workflow → [par(non-last), tail(last)]; par → [x, y]
    const par = node("par", "parallel", {
      children: [node("x", "run.agent"), node("y", "run.agent")]
    });
    const root = node("workflow", "pipeline", { children: [par, node("tail", "run.agent")] });
    const rows = buildRows(buildRenderTree(ir(root), []));
    const byId = (id: string) => rows.find((r) => r.irNode.id === id);
    const prefix = (id: string) => byId(id)?.treeSegments.map((s) => s.text).join("") ?? "";
    // par is a non-last child of root → its children draw a "│  " continuation.
    expect(prefix("x")).toBe("│  ├─ ");
    expect(prefix("y")).toBe("│  └─ ");
    expect(prefix("tail")).toBe("└─ ");
  });

  it("tracks the owning node kind for guide-line columns", () => {
    const par = node("par", "parallel", {
      children: [node("x", "run.agent"), node("y", "run.agent")]
    });
    const root = node("workflow", "pipeline", { children: [par, node("tail", "run.agent")] });
    const rows = buildRows(buildRenderTree(ir(root), []));
    const byId = (id: string) => rows.find((r) => r.irNode.id === id);
    expect(byId("par")?.treeSegments.map((s) => s.ownerKind)).toEqual(["pipeline"]);
    expect(byId("x")?.treeSegments.map((s) => s.ownerKind)).toEqual(["pipeline", "parallel"]);
    expect(byId("y")?.treeSegments.map((s) => s.ownerKind)).toEqual(["pipeline", "parallel"]);
    expect(byId("tail")?.treeSegments.map((s) => s.ownerKind)).toEqual(["pipeline"]);
  });

  it("counts every runtime instance by state", () => {
    const root = node("workflow", "pipeline", {
      children: [node("a", "run.agent"), node("b", "run.agent"), node("g", "approval")]
    });
    const states = [
      state("a", "workflow/a", "completed"),
      state("b", "workflow/b", "running"),
      state("g", "workflow/g", "awaiting")
    ];
    const counts = countByState(buildRenderTree(ir(root), states));
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.awaiting).toBe(1);
    expect(counts.total).toBe(3);
  });

  it("formats elapsed milliseconds as HH:MM:SS", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(3661_000)).toBe("01:01:01");
  });

  it("freezes open-ended durations at a supplied timestamp", () => {
    expect(formatDuration("2026-06-09T00:00:00.000Z", undefined, "2026-06-09T00:00:05.000Z")).toBe("00:00:05");
  });

  it("filters descendants of collapsed rows", () => {
    const rows = [
      { rowKey: "root", depth: 0 },
      { rowKey: "child-a", depth: 1 },
      { rowKey: "grandchild", depth: 2 },
      { rowKey: "child-b", depth: 1 }
    ];
    expect(visibleRows(rows, new Set(["child-a"])).map((r) => r.rowKey)).toEqual([
      "root",
      "child-a",
      "child-b"
    ]);
  });
});
