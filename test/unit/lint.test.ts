import { describe, expect, it } from "vitest";
import { lintWorkflowSpec } from "../../src/compiler/lint.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

function spec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "lint-new-model",
    root: "plan",
    input: { schema: "{task:string,items:[unknown]}", default: { task: "", items: [] } },
    stages: [
      {
        id: "plan",
        kind: "task",
        mode: "agent",
        actor: { agent: "claude", mode: "readOnly", label: "planner" },
        prompt: "Plan ${task}",
        variables: [{ name: "task", source: "input.task" }]
      },
      {
        id: "gate",
        kind: "gate",
        mode: "program",
        dependsOn: ["plan"]
      }
    ]
  });
}

describe("compiler lint", () => {
  it("accepts a minimal stage/task workflow", () => {
    expect(lintWorkflowSpec(spec()).filter((entry) => entry.severity !== "warning")).toEqual([]);
  });

  it("defaults gate mode to program and keeps program gate fields strict", () => {
    const parsed = WorkflowSpecSchema.parse({
      ...spec(),
      stages: [
        spec().stages[0],
        { id: "gate", kind: "gate", dependsOn: ["plan"] }
      ]
    });
    const gate = parsed.stages.find((stage) => stage.kind === "gate");

    expect(gate).toMatchObject({ kind: "gate", mode: "program" });
    expect(WorkflowSpecSchema.safeParse({
      ...spec(),
      stages: [
        spec().stages[0],
        { id: "gate", kind: "gate", dependsOn: ["plan"], actor: { agent: "claude", mode: "readOnly" } }
      ]
    }).success).toBe(false);
    expect(WorkflowSpecSchema.safeParse({
      ...spec(),
      stages: [
        spec().stages[0],
        { id: "gate", kind: "gate", mode: "agent", dependsOn: ["plan"] }
      ]
    }).success).toBe(false);
  });

  it("accepts explicit agent gates with actor and prompt", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      stages: [
        spec().stages[0],
        {
          id: "gate",
          kind: "gate",
          mode: "agent",
          dependsOn: ["plan"],
          actor: { agent: "aiden", mode: "readOnly", label: "gatekeeper" },
          prompt: "Decide whether this run should pass.",
          output: { schema: "{summary:string}" }
        }
      ]
    });

    expect(lintWorkflowSpec(workflow).filter((entry) => entry.severity !== "warning")).toEqual([]);
  });

  it("keeps fanout-only limits out of non-fanout stages", () => {
    for (const stage of [
      { id: "task", kind: "task", mode: "agent", actor: { agent: "claude", mode: "readOnly" }, prompt: "Plan", limits: { maxConcurrency: 2 } },
      { id: "route", kind: "route", mode: "program", rules: [{ when: { source: "input.task", op: "exists" }, to: "gate" }], routes: ["gate"], limits: { maxFanoutItems: 2 } },
      { id: "gate", kind: "gate", limits: { maxConcurrency: 2 } }
    ]) {
      expect(WorkflowSpecSchema.safeParse({
        ...spec(),
        root: stage.id,
        stages: [stage]
      }).success).toBe(false);
    }
  });

  it("requires agent routes to declare actor and prompt at schema validation", () => {
    expect(WorkflowSpecSchema.safeParse({
      ...spec(),
      root: "route",
      stages: [
        {
          id: "route",
          kind: "route",
          mode: "agent",
          rules: [{ when: { source: "input.task", op: "exists" }, to: "gate" }],
          routes: ["gate"]
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["route"] }
      ]
    }).success).toBe(false);
  });

  it("requires route branches to match direct downstream stages", () => {
    const workflow = spec();
    workflow.stages.splice(1, 0,
      {
        id: "route",
        kind: "route",
        mode: "program",
        dependsOn: ["plan"],
        rules: [{ when: { source: "outputs.plan.status", op: "eq", value: "completed" }, to: "left" }],
        routes: ["left", "missing"]
      },
      { id: "left", kind: "task", mode: "program", operation: "command", command: "true", args: [], timeoutSeconds: 60, allowMutation: false, dependsOn: ["route"] }
    );
    workflow.stages[workflow.stages.length - 1] = { id: "gate", kind: "gate", mode: "program", dependsOn: ["left"] };

    const codes = lintWorkflowSpec(workflow).map((entry) => entry.code);
    expect(codes).toContain("ROUTE_ROUTES_MISMATCH");
    expect(codes).toContain("ROUTE_TARGET_UNKNOWN");
  });

  it("validates agent output schema declarations", () => {
    const workflow = spec();
    workflow.stages[0] = {
      ...workflow.stages[0],
      kind: "task",
      mode: "agent",
      actor: { agent: "claude", mode: "readOnly" },
      prompt: "Plan ${task}",
      output: { schema: "{summary:string,data?:Record}" }
    };

    expect(lintWorkflowSpec(workflow).map((entry) => entry.code)).toContain("OUTPUT_SCHEMA_DSL_INVALID");
  });

  it("requires fanout lane prompts and keeps fanin explicit", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          lanes: [{ id: "a", actor: { agent: "aiden", mode: "readOnly" } }],
          fanin: { mode: "program", operation: "mergeArrays" }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });

    expect(lintWorkflowSpec(workflow).map((entry) => entry.code)).toContain("FANOUT_LANE_PROMPT_REQUIRED");
  });

  it("allows agent fanin prompts to reference implicit results", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          prompt: "Review item",
          lanes: [{ id: "a", actor: { agent: "aiden", mode: "readOnly" } }],
          fanin: {
            mode: "agent",
            actor: { agent: "aiden", mode: "readOnly" },
            prompt: "Deduplicate ${results}",
            output: { schema: "{summary:string,data:[unknown]}" }
          }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });

    expect(lintWorkflowSpec(workflow).filter((entry) => entry.severity !== "warning")).toEqual([]);
  });

  it("rejects results outside agent fanin prompts", () => {
    const laneWorkflow = WorkflowSpecSchema.parse({
      ...spec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          lanes: [{ id: "a", actor: { agent: "aiden", mode: "readOnly" }, prompt: "Review ${results}" }],
          fanin: { mode: "program", operation: "mergeArrays" }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });
    const taskWorkflow = WorkflowSpecSchema.parse({
      ...spec(),
      stages: [
        {
          ...spec().stages[0],
          prompt: "Plan ${results}"
        },
        spec().stages[1]
      ]
    });
    const gateWorkflow = WorkflowSpecSchema.parse({
      ...spec(),
      stages: [
        spec().stages[0],
        {
          id: "gate",
          kind: "gate",
          mode: "agent",
          actor: { agent: "aiden", mode: "readOnly" },
          dependsOn: ["plan"],
          prompt: "Gate ${results}"
        }
      ]
    });

    expect(lintWorkflowSpec(laneWorkflow).map((entry) => entry.code)).toContain("VARIABLE_UNDECLARED");
    expect(lintWorkflowSpec(taskWorkflow).map((entry) => entry.code)).toContain("VARIABLE_UNDECLARED");
    expect(lintWorkflowSpec(gateWorkflow).map((entry) => entry.code)).toContain("VARIABLE_UNDECLARED");
  });

  it("rejects undeclared run source variables", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      stages: [
        {
          ...spec().stages[0],
          variables: [{ name: "runId", source: "run.id" }],
          prompt: "Plan ${runId}"
        },
        spec().stages[1]
      ]
    });

    expect(lintWorkflowSpec(workflow).map((entry) => entry.code)).toContain("VARIABLE_SOURCE_INVALID");
  });

  it("rejects item-scoped variables in agent fanin prompts", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          variables: [{ name: "sliceId", source: "item.id" }],
          prompt: "Review ${sliceId}",
          lanes: [{ id: "a", actor: { agent: "aiden", mode: "readOnly" } }],
          fanin: {
            mode: "agent",
            actor: { agent: "aiden", mode: "readOnly" },
            prompt: "Deduplicate ${sliceId} ${results}",
            output: { schema: "{summary:string,data:[unknown]}" }
          }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });

    const issues = lintWorkflowSpec(workflow).filter((entry) => entry.severity !== "warning");

    expect(issues.map((entry) => entry.code)).toContain("VARIABLE_UNDECLARED");
    expect(issues.map((entry) => entry.message).join("\n")).toContain("item-scoped variable sliceId");
  });

  it("rejects user-declared results variables for agent fanin", () => {
    const workflow = WorkflowSpecSchema.parse({
      ...spec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          variables: [{ name: "results", source: "input.task" }],
          prompt: "Review item",
          lanes: [{ id: "a", actor: { agent: "aiden", mode: "readOnly" } }],
          fanin: {
            mode: "agent",
            actor: { agent: "aiden", mode: "readOnly" },
            prompt: "Deduplicate ${results}",
            output: { schema: "{summary:string,data:[unknown]}" }
          }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });

    const issues = lintWorkflowSpec(workflow).filter((entry) => entry.severity !== "warning");

    expect(issues.map((entry) => entry.code)).toContain("VARIABLE_RESERVED");
  });

  it("rejects route as loop body output", () => {
    const workflow = spec();
    workflow.stages[0] = {
      id: "quality_loop",
      kind: "loop",
      maxRounds: 2,
      body: {
        root: "work",
        output: "route",
        stages: [
          { id: "work", kind: "task", mode: "program", operation: "command", command: "true", args: [], timeoutSeconds: 60, allowMutation: false },
          {
            id: "route",
            kind: "route",
            mode: "program",
            dependsOn: ["work"],
            rules: [{ when: { source: "outputs.work.status", op: "eq", value: "completed" }, to: "work" }],
            routes: ["work"]
          }
        ]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    };
    workflow.stages[1] = { id: "gate", kind: "gate", mode: "program", dependsOn: ["quality_loop"] };

    expect(lintWorkflowSpec(workflow).map((entry) => entry.code)).toContain("LOOP_BODY_OUTPUT_ROUTE_INVALID");
  });
});
