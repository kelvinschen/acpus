import { describe, it, expect } from "vitest";
import type { AcpusIr, IrNode } from "@acpus/core";
import type { NodeExecutionState } from "@acpus/runtime";
import {
  buildRenderTree,
  buildRows,
  countByState,
  aggregateState,
  indexByNodeId,
  formatDuration,
  formatElapsed
} from "../../src/model.js";
import { visibleRows } from "../../src/components/App.js";

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

function branchPipeline(parentPath: string[], branchId: string, childId: string): IrNode {
  const pipelineId = branchId === "default" ? "$default" : `$${branchId}`;
  const pipelinePath = [...parentPath, pipelineId];
  const childPath = [...pipelinePath, childId];
  return node(pipelineId, "pipeline", {
    nodePath: pipelinePath,
    keyTemplate: { astVersion: 1, nodePath: pipelinePath.join("/") },
    metadata: { generated: true },
    children: [node(childId, "run.agent", {
      nodePath: childPath,
      keyTemplate: { astVersion: 1, nodePath: childPath.join("/") }
    })]
  });
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

  it("renders nested fanout groups under the correct outer lane", () => {
    const inner = node("inner", "fanout", { children: [node("work", "run.agent")] });
    const outer = node("outer", "fanout", { children: [inner] });
    const root = node("workflow", "pipeline", { children: [outer] });
    const states = [
      state("work", "workflow/outer/inner/work/item:A/lane:0/item:x/lane:0", "completed"),
      state("work", "workflow/outer/inner/work/item:B/lane:1/item:x/lane:0", "failed")
    ];

    const rows = buildRows(buildRenderTree(ir(root), states));
    const outerGroups = rows.filter((r) => r.irNode.id === "outer" && r.groupDim === "lane");
    const innerGroups = rows.filter((r) => r.irNode.id === "inner" && r.groupDim === "lane");

    expect(outerGroups.map((r) => r.groupItem)).toEqual(["A", "B"]);
    expect(innerGroups).toHaveLength(2);
    expect(innerGroups.every((r) => r.groupItem === "x")).toBe(true);
    expect(innerGroups.map((r) => r.groupItem)).toEqual(["x", "x"]);
    expect(innerGroups.map((r) => r.rowKey)).not.toEqual([innerGroups[0].rowKey, innerGroups[0].rowKey]);
    expect(rows.filter((r) => r.irNode.id === "work")).toHaveLength(2);
  });

  it("renders if branches as synthetic headers", () => {
    const maybe = node("maybe", "if", {
      branches: [
        { id: "then", when: "input.enabled", child: branchPipeline(["workflow", "maybe"], "then", "enabled") },
        { id: "else", child: branchPipeline(["workflow", "maybe"], "else", "disabled") }
      ]
    });
    const root = node("workflow", "pipeline", { children: [maybe] });
    const rows = buildRows(buildRenderTree(ir(root), []));

    expect(rows.map((r) => r.label)).toEqual(["workflow", "maybe", "then", "enabled", "else", "disabled"]);
    expect(rows.filter((r) => r.rowKind === "branch").map((r) => [r.label, r.branchWhen])).toEqual([
      ["then", "input.enabled"],
      ["else", undefined]
    ]);
    expect(rows.filter((r) => r.rowKind === "branch").every((r) => r.isHeader)).toBe(true);
    expect(rows.some((r) => r.irNode.id === "$then")).toBe(false);
    expect(rows.some((r) => r.irNode.id === "$else")).toBe(false);
  });

  it("renders switch branches as synthetic headers", () => {
    const sw = node("decide", "switch", {
      branches: [
        { id: "case_1", when: "x > 1", child: branchPipeline(["workflow", "decide"], "case_1", "hot") },
        { id: "default", child: branchPipeline(["workflow", "decide"], "default", "cold") }
      ]
    });
    const root = node("workflow", "pipeline", { children: [sw] });
    const rows = buildRows(buildRenderTree(ir(root), []));

    expect(rows.map((r) => r.label)).toEqual(["workflow", "decide", "case_1", "hot", "default", "cold"]);
    expect(rows.filter((r) => r.rowKind === "branch").map((r) => [r.label, r.branchWhen])).toEqual([
      ["case_1", "x > 1"],
      ["default", undefined]
    ]);
    expect(rows.filter((r) => r.rowKind === "branch").every((r) => r.isHeader)).toBe(true);
    expect(rows.some((r) => r.irNode.id === "$case_1")).toBe(false);
    expect(rows.some((r) => r.irNode.id === "$default")).toBe(false);
  });

  it("keeps untaken if branches visible without runtime state", () => {
    const maybe = node("maybe", "if", {
      branches: [
        { id: "then", when: "input.enabled", child: branchPipeline(["workflow", "maybe"], "then", "enabled") },
        { id: "else", child: branchPipeline(["workflow", "maybe"], "else", "disabled") }
      ]
    });
    const root = node("workflow", "pipeline", { children: [maybe] });
    const rows = buildRows(buildRenderTree(ir(root), [
      state("maybe", "workflow/maybe", "completed", 1, "if"),
      state("enabled", "workflow/maybe/$then/enabled", "completed")
    ]));

    expect(rows.find((r) => r.label === "enabled")?.state).toBe("completed");
    expect(rows.find((r) => r.label === "disabled")?.state).toBeUndefined();
    expect(rows.find((r) => r.label === "then" && r.rowKind === "branch")?.state).toBe("completed");
    expect(rows.find((r) => r.label === "else" && r.rowKind === "branch")?.state).toBeUndefined();
    expect(rows.filter((r) => r.rowKind === "branch").map((r) => r.label)).toEqual(["then", "else"]);
  });

  it("keeps untaken switch branches visible without runtime state", () => {
    const sw = node("decide", "switch", {
      branches: [
        { id: "case_1", when: "x > 1", child: branchPipeline(["workflow", "decide"], "case_1", "hot") },
        { id: "default", child: branchPipeline(["workflow", "decide"], "default", "cold") }
      ]
    });
    const root = node("workflow", "pipeline", { children: [sw] });
    const rows = buildRows(buildRenderTree(ir(root), [
      state("decide", "workflow/decide", "completed", 1, "switch"),
      state("cold", "workflow/decide/$default/cold", "completed")
    ]));

    expect(rows.find((r) => r.label === "hot")?.state).toBeUndefined();
    expect(rows.find((r) => r.label === "cold")?.state).toBe("completed");
    expect(rows.find((r) => r.label === "case_1" && r.rowKind === "branch")?.state).toBeUndefined();
    expect(rows.find((r) => r.label === "default" && r.rowKind === "branch")?.state).toBe("completed");
    expect(rows.filter((r) => r.rowKind === "branch").map((r) => r.label)).toEqual(["case_1", "default"]);
  });

  it("scopes branch rows independently under fanout lanes", () => {
    const maybe = node("maybe", "if", {
      branches: [
        { id: "then", when: "item.enabled", child: branchPipeline(["workflow", "mapped", "maybe"], "then", "enabled") },
        { id: "else", child: branchPipeline(["workflow", "mapped", "maybe"], "else", "disabled") }
      ],
      nodePath: ["workflow", "mapped", "maybe"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/mapped/maybe" }
    });
    const fan = node("mapped", "fanout", {
      children: [maybe],
      nodePath: ["workflow", "mapped"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/mapped" }
    });
    const root = node("workflow", "pipeline", { children: [fan] });
    const rows = buildRows(buildRenderTree(ir(root), [
      state("enabled", "workflow/mapped/maybe/$then/enabled/item:a/lane:0", "completed"),
      state("disabled", "workflow/mapped/maybe/$else/disabled/item:b/lane:1", "failed")
    ]));

    expect(new Set(rows.map((r) => r.rowKey)).size).toBe(rows.length);
    const branchRows = rows.filter((r) => r.rowKind === "branch");
    expect(branchRows.map((r) => [r.label, r.state])).toEqual([
      ["then", "completed"],
      ["else", undefined],
      ["then", undefined],
      ["else", "failed"]
    ]);
  });

  it("hides duplicate generated pipeline rows while matching children by full node path", () => {
    const leftBody = node("$do", "pipeline", {
      nodePath: ["workflow", "left", "$do"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/left/$do" },
      metadata: { generated: true },
      children: [node("left_work", "run.agent", {
        nodePath: ["workflow", "left", "$do", "left_work"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/left/$do/left_work" }
      })]
    });
    const rightBody = node("$do", "pipeline", {
      nodePath: ["workflow", "right", "$do"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/right/$do" },
      metadata: { generated: true },
      children: [node("right_work", "run.agent", {
        nodePath: ["workflow", "right", "$do", "right_work"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/right/$do/right_work" }
      })]
    });
    const root = node("workflow", "pipeline", {
      children: [
        node("left", "fanout", { children: [leftBody] }),
        node("right", "fanout", { children: [rightBody] })
      ]
    });
    const rows = buildRows(buildRenderTree(ir(root), [
      state("left_work", "workflow/left/$do/left_work/item:A/lane:0", "completed"),
      state("right_work", "workflow/right/$do/right_work/item:B/lane:0", "failed")
    ]));

    const bodyRows = rows.filter((r) => r.irNode.id === "$do");
    expect(bodyRows).toEqual([]);
    expect(rows.find((r) => r.irNode.id === "left_work")?.state).toBe("completed");
    expect(rows.find((r) => r.irNode.id === "right_work")?.state).toBe("failed");
  });

  it("inlines generated parallel branch pipelines as structure", () => {
    const par = node("par", "parallel", {
      branches: [
        {
          id: "upper",
          child: node("$upper", "pipeline", {
            metadata: { generated: true },
            children: [node("up", "run.agent")]
          })
        },
        {
          id: "route",
          child: node("$route", "pipeline", {
            metadata: { generated: true },
            children: [node("route", "run.agent")]
          })
        }
      ]
    });
    const root = node("workflow", "pipeline", { children: [par] });
    const rows = buildRows(buildRenderTree(ir(root), []));

    expect(rows.map((r) => r.irNode.id)).toEqual(["workflow", "par", "up", "route"]);
    expect(rows.find((r) => r.irNode.id === "up")?.branchLabel).toBe("upper");
    expect(rows.find((r) => r.irNode.id === "route")?.branchLabel).toBe("route");
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
      branches: [
        { id: "left", child: node("$left", "pipeline", { metadata: { generated: true }, children: [node("x", "run.agent")] }) },
        { id: "right", child: node("$right", "pipeline", { metadata: { generated: true }, children: [node("y", "run.agent")] }) }
      ]
    });
    const root = node("workflow", "pipeline", { children: [par, node("tail", "run.agent")] });
    const rows = buildRows(buildRenderTree(ir(root), []));
    const byId = (id: string) => rows.find((r) => r.irNode.id === id);
    const prefix = (id: string) => byId(id)?.treeSegments.map((s) => s.text).join("") ?? "";
    // Generated branch pipelines are structural, so x/y sit directly under par.
    expect(prefix("x")).toBe("│  ├─ ");
    expect(prefix("y")).toBe("│  └─ ");
    expect(prefix("tail")).toBe("└─ ");
  });

  it("tracks the owning node kind for guide-line columns", () => {
    const par = node("par", "parallel", {
      branches: [
        { id: "left", child: node("$left", "pipeline", { metadata: { generated: true }, children: [node("x", "run.agent")] }) },
        { id: "right", child: node("$right", "pipeline", { metadata: { generated: true }, children: [node("y", "run.agent")] }) }
      ]
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
      children: [node("a", "run.agent"), node("b", "run.agent"), node("g", "run.signal")]
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
