import { describe, expect, it } from "vitest";
import type { ExprIR, NodeIR, ScopeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { renderWorkflowTerminalViz } from "../src/workflow-terminal-viz.js";

const emptyOutput = { kind: "object", fields: {} } satisfies ExprIR;
const truthy = { kind: "literal", value: true } satisfies ExprIR;

describe("workflow terminal visualization", () => {
  it("renders a single-root Parallel as the tree root with required output keys", () => {
    expect(renderWorkflowTerminalViz(parallelApprovals())).toBe(`parallel-approvals
input { changeId: string }
output { security: { approved }, operations: { approved } }
agents: none

≡ approvals · parallel
├┄ security
│  └─ ◌ security_approval · signal
└┄ operations
   └─ ◌ operations_approval · signal`);
  });

  it("renders every remaining node kind, detached roots, arrays, and Agent disclosure", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
      name: "semantic-fixture",
      agents: {
        triager: {
          kind: "agent_definition",
          use: "codex",
          model: "gpt-5",
          permissionMode: "approve-all",
          config: { mode: "plan" },
        },
      },
      root: scope([
        agent("plan"),
        task("fetch"),
        signal("approve"),
        assertion("require"),
        {
          id: "gate",
          kind: "if",
          condition: truthy,
          then: scope([assertion("then_check")]),
          else: scope([task("else_task")]),
        },
        {
          id: "route",
          kind: "switch",
          cases: [{ when: truthy, then: scope([agent("case_agent")]) }],
          default: scope([signal("default_signal")]),
        },
        {
          id: "items",
          kind: "fanout",
          over: { kind: "array", items: [] },
          strategy: "all",
          do: scope([task("handle_item")], nodeOutput("handle_item")),
        },
        {
          id: "repeat",
          kind: "loop",
          state: { kind: "object", fields: { count: { kind: "literal", value: 0 } } },
          do: {
            nodes: [task("repeat_task")],
            output: {
              kind: "object",
              fields: { state: nodeOutput("repeat_task"), stop: truthy },
            },
          },
        },
      ], {
        kind: "object",
        fields: { ok: truthy, items: nodeOutput("items") },
      }),
      diagnostics: [],
    };

    expect(renderWorkflowTerminalViz(ir)).toBe(`semantic-fixture
input {}
output { ok, items: …[] }
agents: triager (codex, gpt-5, plan)

┌─ ✦ plan · agent(triager)
├─ $ fetch · task
├─ ◌ approve · signal
├─ ◈ require · assert
├─ ? gate · if
│  ├┄ then
│  │  └─ ◈ then_check · assert
│  └┄ else
│     └─ $ else_task · task
├─ ⎇ route · switch
│  ├┄ case 1
│  │  └─ ✦ case_agent · agent(triager)
│  └┄ default
│     └─ ◌ default_signal · signal
├─ ✣ items · fanout
│  └─ $ handle_item · task
└─ ↻ repeat · loop
   └─ $ repeat_task · task`);
    expect(renderWorkflowTerminalViz(ir, { color: true })).toContain("\u001b[2m · agent(triager)\u001b[0m");
  });

  it("applies ANSI only when requested and leaves an empty workflow compact", () => {
    const colored = renderWorkflowTerminalViz(parallelApprovals(), { color: true });
    expect(colored).toContain("\u001b[1mparallel-approvals\u001b[0m");
    expect(colored).toContain("\u001b[96m≡\u001b[0m approvals\u001b[2m · parallel\u001b[0m");

    const empty: WorkflowIR = {
      irVersion: 6,
      name: "empty-workflow",
      agents: {},
      root: scope([]),
      diagnostics: [],
    };
    expect(renderWorkflowTerminalViz(empty)).toBe(`empty-workflow
input {}
output {}
agents: none`);
  });
});

function parallelApprovals(): WorkflowIR {
  const approvalSchema: SchemaIR = {
    kind: "object",
    fields: {
      approved: { kind: "boolean" },
      note: { kind: "string", default: "", optional: true },
    },
    required: ["approved"],
    additionalProperties: false,
  };
  const branch = (id: string): ScopeIR => scope(
    [signal(id, approvalSchema)],
    nodeOutput(id),
  );
  return {
    irVersion: 6,
    name: "parallel-approvals",
    inputSchema: {
      kind: "object",
      fields: { changeId: { kind: "string" } },
      required: ["changeId"],
      additionalProperties: false,
    },
    agents: {},
    root: scope([{
      id: "approvals",
      kind: "parallel",
      strategy: "all",
      branches: {
        security: branch("security_approval"),
        operations: branch("operations_approval"),
      },
    }], nodeOutput("approvals")),
    diagnostics: [],
  };
}

function scope(nodes: NodeIR[], output: ExprIR = emptyOutput): ScopeIR {
  return { nodes, output };
}

function nodeOutput(id: string): ExprIR {
  return { kind: "ref", path: ["nodes", id, "output"] };
}

function agent(id: string): Extract<NodeIR, { kind: "agent" }> {
  return {
    id,
    kind: "agent",
    run: { agent: "triager", prompt: { kind: "literal", value: "work" } },
  };
}

function task(id: string): Extract<NodeIR, { kind: "task" }> {
  return {
    id,
    kind: "task",
    run: { input: {}, target: { kind: "inline", source: "async () => ({})" } },
  };
}

function signal(id: string, outputSchema?: SchemaIR): Extract<NodeIR, { kind: "signal" }> {
  return {
    id,
    kind: "signal",
    run: { prompt: { kind: "literal", value: "approve" } },
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function assertion(id: string): Extract<NodeIR, { kind: "assert" }> {
  return { id, kind: "assert", condition: truthy };
}
