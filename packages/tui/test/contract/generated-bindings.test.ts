import { describe, expect, it } from "vitest";
import type { AcpusIr, NodeExecutionState, RunState } from "@acpus/bindings";
import { buildRenderTree, countByState } from "../../src/model.js";

describe("generated bindings contract", () => {
  it("feeds generated runtime types into the TUI view model", () => {
    const ir: AcpusIr = {
      irVersion: 1,
      astVersion: 1,
      source: { digest: "digest" },
      name: "generated-bindings",
      input: {},
      agents: {},
      outputs: {},
      expressions: [],
      root: {
        id: "workflow",
        kind: "pipeline",
        nodePath: ["workflow"],
        keyTemplate: { astVersion: 1, nodePath: "workflow" },
        metadata: {},
        children: [
          {
            id: "build",
            kind: "run.program",
            nodePath: ["workflow", "build"],
            keyTemplate: { astVersion: 1, nodePath: "workflow/build" },
            metadata: {}
          }
        ]
      }
    };

    const node: NodeExecutionState = {
      nodeKey: "workflow/build",
      nodeId: "build",
      kind: "run.program",
      state: "completed",
      attempt: 1,
      output: { ok: true }
    };

    const run: RunState = {
      runId: "run-1",
      workflowName: ir.name,
      status: "completed",
      irDigest: "ir-digest",
      inputDigest: "input-digest",
      createdAt: "2026-06-26T00:00:00Z",
      updatedAt: "2026-06-26T00:00:01Z",
      runAttempt: 1,
      nodes: [node]
    };

    const tree = buildRenderTree(ir, run.nodes ?? []);
    const counts = countByState(tree);

    expect(tree.children[0]?.instances[0]).toEqual(node);
    expect(counts.completed).toBe(1);
    expect(counts.total).toBe(1);
  });
});
