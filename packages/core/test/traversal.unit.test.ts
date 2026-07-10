import { describe, expect, it } from "vitest";
import { childScopes, walkNodes, type NodeChildScope } from "../src/ir/traversal.js";
import type { ExprIR, ScopeIR, TaskNodeIR } from "../src/ir/types.js";

const truthy: ExprIR = { kind: "literal", value: true };

function taskNode(id: string): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      kind: "task_run",
      input: {},
      target: { kind: "inline", runtime: "node", source: "async () => ({})" },
    },
  };
}

const allNodeKinds: ScopeIR = {
  nodes: [
    {
      id: "agent",
      kind: "agent",
      run: { kind: "agent_run", agent: "worker", prompt: truthy },
    },
    taskNode("task"),
    {
      id: "signal",
      kind: "signal",
      run: { kind: "signal_run", prompt: truthy },
    },
    { id: "assert", kind: "assert", condition: truthy },
    {
      id: "if",
      kind: "if",
      condition: truthy,
      then: { nodes: [taskNode("if_then")] },
      else: { nodes: [taskNode("if_else")] },
    },
    {
      id: "switch",
      kind: "switch",
      cases: [
        { when: truthy, then: { nodes: [taskNode("switch_case_0")] } },
        { when: truthy, then: { nodes: [taskNode("switch_case_1")] } },
      ],
      default: { nodes: [taskNode("switch_default")] },
    },
    {
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        first: { scope: { nodes: [taskNode("parallel_first")] } },
        second: { scope: { nodes: [taskNode("parallel_second")] } },
      },
    },
    {
      id: "fanout",
      kind: "fanout",
      strategy: "all",
      over: { kind: "literal", value: [] },
      do: {
        nodes: [
          {
            id: "loop",
            kind: "loop",
            state: truthy,
            do: {
              nodes: [taskNode("loop_do")],
              outputs: { state: truthy, stop: truthy },
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
