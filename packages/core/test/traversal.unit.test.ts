import { describe, expect, it } from "vitest";
import { childScopes, walkNodes, type NodeChildScope } from "../src/ir/traversal.js";
import type { ExprIR, ScopeIR, TaskNodeIR } from "../src/ir/types.js";

const truthy: ExprIR = { kind: "literal", value: true };

function taskNode(id: string): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source: "async () => ({})" },
    },
  };
}

const allNodeKinds: ScopeIR = {
  output: { kind: "object", fields: {} },
  nodes: [
    {
      id: "agent",
      kind: "agent",
      run: { agent: "worker", prompt: truthy },
    },
    taskNode("task"),
    {
      id: "signal",
      kind: "signal",
      run: { prompt: truthy },
    },
    { id: "assert", kind: "assert", condition: truthy },
    {
      id: "if",
      kind: "if",
      condition: truthy,
      then: { output: { kind: "object", fields: {} }, nodes: [taskNode("if_then")] },
      else: { output: { kind: "object", fields: {} }, nodes: [taskNode("if_else")] },
    },
    {
      id: "switch",
      kind: "switch",
      cases: [
        { when: truthy, then: { output: { kind: "object", fields: {} }, nodes: [taskNode("switch_case_0")] } },
        { when: truthy, then: { output: { kind: "object", fields: {} }, nodes: [taskNode("switch_case_1")] } },
      ],
      default: { output: { kind: "object", fields: {} }, nodes: [taskNode("switch_default")] },
    },
    {
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        first: { output: { kind: "object", fields: {} }, nodes: [taskNode("parallel_first")] },
        second: { output: { kind: "object", fields: {} }, nodes: [taskNode("parallel_second")] },
      },
    },
    {
      id: "fanout",
      kind: "fanout",
      strategy: "all",
      over: { kind: "array", items: [] },
      do: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "loop",
            kind: "loop",
            state: truthy,
            do: {
              nodes: [taskNode("loop_do")],
              output: { kind: "object", fields: { state: truthy, stop: truthy } },
            },
          },
        ],
      },
    },
  ],
};

function childIdentity(child: NodeChildScope): string {
  return "branchId" in child
    ? `${child.kind}:${child.owner.id}:${child.branchId}`
    : `${child.kind}:${child.owner.id}`;
}

describe("WorkflowIR traversal", () => {
  it("enumerates every composite child scope in authored order", () => {
    expect(
      [...walkNodes(allNodeKinds)].flatMap(({ node }) => childScopes(node).map(childIdentity)),
    ).toEqual([
      "if:if:then",
      "if:if:else",
      "switch:switch:case:0",
      "switch:switch:case:1",
      "switch:switch:default",
      "parallel:parallel:first",
      "parallel:parallel:second",
      "fanout:fanout",
      "loop:loop",
    ]);
  });

  it("walks all nine node kinds in depth-first pre-order with outermost-first ancestry", () => {
    const visits = [...walkNodes(allNodeKinds)];

    expect(visits.map(({ node }) => node.id)).toEqual([
      "agent",
      "task",
      "signal",
      "assert",
      "if",
      "if_then",
      "if_else",
      "switch",
      "switch_case_0",
      "switch_case_1",
      "switch_default",
      "parallel",
      "parallel_first",
      "parallel_second",
      "fanout",
      "loop",
      "loop_do",
    ]);
    expect(
      visits
        .filter(({ ancestry }) => ancestry.length > 0)
        .map(({ node, ancestry }) => ({
          id: node.id,
          ancestry: ancestry.map(childIdentity),
        })),
    ).toEqual([
      { id: "if_then", ancestry: ["if:if:then"] },
      { id: "if_else", ancestry: ["if:if:else"] },
      { id: "switch_case_0", ancestry: ["switch:switch:case:0"] },
      { id: "switch_case_1", ancestry: ["switch:switch:case:1"] },
      { id: "switch_default", ancestry: ["switch:switch:default"] },
      { id: "parallel_first", ancestry: ["parallel:parallel:first"] },
      { id: "parallel_second", ancestry: ["parallel:parallel:second"] },
      { id: "loop", ancestry: ["fanout:fanout"] },
      { id: "loop_do", ancestry: ["fanout:fanout", "loop:loop"] },
    ]);
  });
});
