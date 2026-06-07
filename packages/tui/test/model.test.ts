import { describe, it, expect } from "vitest";
import type { AcpusIr, IrNode } from "@acpus/core";
import type { NodeExecutionState } from "@acpus/runtime";
import {
  buildRenderTree,
  buildRows,
  countByState,
  aggregateState,
  indexByNodeId,
  formatElapsed
} from "../src/model.js";

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

  it("groups fanout lanes under one IR node id", () => {
    const fan = node("mapped", "fanout", { children: [node("work", "run.agent")] });
    const root = node("workflow", "pipeline", { children: [fan] });
    const states = [
      state("work", "workflow/mapped/item:a/lane:0", "completed"),
      state("work", "workflow/mapped/item:b/lane:1", "running")
    ];
    const idx = indexByNodeId(states);
    expect(idx.get("work")).toHaveLength(2);

    const rows = buildRows(buildRenderTree(ir(root), states));
    // Header row for the expanded "work" node + one row per lane.
    const workRows = rows.filter((r) => r.irNode.id === "work");
    expect(workRows[0].isHeader).toBe(true);
    expect(workRows[0].label).toContain("×2");
    expect(workRows).toHaveLength(3);
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
      state("work", "workflow/mapped/item:a", "completed"),
      state("work", "workflow/mapped/item:b", "failed")
    ];
    const tree = buildRenderTree(ir(root), states);
    const workNode = tree.children[0].children[0];
    expect(aggregateState(workNode)).toBe("failed");
  });

  it("counts every runtime instance by state", () => {
    const root = node("workflow", "pipeline", {
      children: [node("a", "run.agent"), node("b", "run.agent")]
    });
    const states = [
      state("a", "workflow/a", "completed"),
      state("b", "workflow/b", "running")
    ];
    const counts = countByState(buildRenderTree(ir(root), states));
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("formats elapsed milliseconds as HH:MM:SS", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(3661_000)).toBe("01:01:01");
  });
});
