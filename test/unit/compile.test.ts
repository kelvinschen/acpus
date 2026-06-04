import { describe, expect, it } from "vitest";
import { compileExecutionPlan, renderStagePrompt } from "../../src/compiler/compile.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

function baseSpec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "simple-feature",
    root: "plan",
    input: { schema: "{task:string,items?:[unknown]}", default: { task: "ship it" } },
    limits: { stageTimeoutMinutes: 45 },
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
        id: "implement",
        kind: "task",
        mode: "agent",
        actor: { agent: "codex", mode: "edit", label: "implementer" },
        dependsOn: ["plan"],
        prompt: "Implement"
      },
      {
        id: "gate",
        kind: "gate",
        dependsOn: ["implement"]
      }
    ]
  });
}

describe("compileExecutionPlan", () => {
  it("creates stage/task plan with output schema footer", () => {
    const plan = compileExecutionPlan(baseSpec());

    expect(plan.version).toBe("acpus.execution-plan/v1");
    expect(plan.workflowName).toBe("simple-feature");
    expect(plan.stages.map((stage) => stage.id)).toEqual(["plan", "implement", "gate"]);
    expect(plan.prompts.plan.footer).toContain("# Final Output Contract");
    expect(plan.prompts.plan.footer).toContain("After completing the whole task");
    expect(plan.prompts.plan.footer).toContain("without ```json fence");
    expect(plan.prompts.plan.footer).toContain("```typescript");
    expect(plan.prompts.plan.footer).toContain("summary: string");
    expect(plan.prompts.plan.footer).toContain("data?: unknown");
    expect(plan.prompts.plan.footer).not.toContain("Workflow Stage Contract");
  });

  it("plans fanout lanes with inline actors and program fanin", () => {
    const spec = WorkflowSpecSchema.parse({
      ...baseSpec(),
      root: "review",
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          prompt: "Review ${path}",
          variables: [{ name: "path", source: "item.path" }],
          limits: { maxConcurrency: 4, maxFanoutItems: 10 },
          lanes: [
            { id: "codex", actor: { agent: "codex", mode: "readOnly", label: "codex-reviewer" } },
            { id: "claude", actor: { agent: "claude", mode: "readOnly", label: "claude-reviewer" }, prompt: "Claude review ${path}" }
          ],
          fanin: { mode: "program", operation: "mergeArrays" },
          fanoutPolicy: { allowPartial: true }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ],
      input: { schema: "{items:[unknown]}", default: { items: [] } }
    });
    const plan = compileExecutionPlan(spec);
    const fanout = plan.stages.find((stage) => stage.id === "review");

    expect(fanout?.session).toEqual({ kind: "fanoutItem", template: "fanout:review:item:{itemId}:lane:{laneId}" });
    expect(fanout?.fanout).toMatchObject({ itemsSource: "input.items", allowPartial: true, maxConcurrency: 4, maxItems: 10 });
    expect(fanout?.fanout?.lanes.map((lane) => [lane.id, lane.actor.label, lane.promptId])).toEqual([
      ["codex", "codex-reviewer", "review__codex"],
      ["claude", "claude-reviewer", "review__claude"]
    ]);
    expect(fanout?.fanout?.fanin).toEqual({ mode: "program", operation: "mergeArrays" });
  });

  it("resolves input-sourced run-start limits into numeric execution plan values", () => {
    const spec = WorkflowSpecSchema.parse({
      ...baseSpec(),
      root: "review",
      input: {
        schema: "{items:[unknown],stageTimeoutMinutes:number,maxConcurrency?:number,maxFanoutItems?:number}",
        default: { items: [], stageTimeoutMinutes: 30, maxConcurrency: 2 }
      },
      limits: {
        stageTimeoutMinutes: { source: "input.stageTimeoutMinutes" }
      },
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          prompt: "Review",
          limits: {
            maxConcurrency: { source: "input.maxConcurrency" },
            maxFanoutItems: { source: "input.maxFanoutItems", default: 12 }
          },
          lanes: [
            { id: "aiden", actor: { agent: "aiden", mode: "readOnly" } }
          ],
          fanin: { mode: "program", operation: "mergeArrays" }
        },
        { id: "gate", kind: "gate", dependsOn: ["review"] }
      ]
    });

    const plan = compileExecutionPlan(spec, { input: { items: [], stageTimeoutMinutes: 5, maxConcurrency: 4 } });
    const fanout = plan.stages.find((stage) => stage.id === "review");

    expect(plan.limits.stageTimeoutMinutes).toBe(5);
    expect(fanout?.limits).toEqual({ maxConcurrency: 4, maxFanoutItems: 12, stageTimeoutMinutes: undefined });
    expect(fanout?.fanout).toMatchObject({ maxConcurrency: 4, maxItems: 12 });
  });

  it("plans default program gates without agent prompt state", () => {
    const plan = compileExecutionPlan(baseSpec());
    const gate = plan.stages.find((stage) => stage.id === "gate");

    expect(gate).toMatchObject({
      id: "gate",
      kind: "gate",
      dependencies: ["implement"],
      gate: { mode: "program" },
      session: { kind: "linear", key: "stage:gate" }
    });
    expect(gate?.agent).toBeUndefined();
    expect(gate?.program).toBeUndefined();
    expect(plan.prompts.gate).toBeUndefined();
  });

  it("plans explicit agent gates with actor, prompt, schema, and implicit verdict", () => {
    const spec = WorkflowSpecSchema.parse({
      ...baseSpec(),
      stages: [
        ...baseSpec().stages.slice(0, 2),
        {
          id: "gate",
          kind: "gate",
          mode: "agent",
          actor: { agent: "aiden", mode: "readOnly", label: "gatekeeper" },
          dependsOn: ["implement"],
          prompt: "Decide whether the implementation passes.",
          output: { schema: "{summary:string}" }
        }
      ]
    });

    const plan = compileExecutionPlan(spec);
    const gate = plan.stages.find((stage) => stage.id === "gate");

    expect(gate).toMatchObject({
      id: "gate",
      kind: "gate",
      dependencies: ["implement"],
      session: { kind: "linear", key: "gate:gate" },
      gate: { mode: "agent" },
      agent: {
        actor: { agent: "aiden", mode: "readOnly", label: "gatekeeper" },
        promptId: "gate",
        implicitOutputFields: ["verdict"]
      }
    });
    expect(gate?.agent?.outputSchema).toBeDefined();
    expect(plan.prompts.gate).toMatchObject({
      id: "gate",
      stageId: "gate",
      actor: { agent: "aiden", mode: "readOnly", label: "gatekeeper" },
      implicitOutputFields: ["verdict"]
    });
    expect(plan.prompts.gate.footer).toContain("verdict");
  });

  it("plans agent routes with constrained implicit route footers", () => {
    const spec = WorkflowSpecSchema.parse({
      ...baseSpec(),
      root: "decide",
      stages: [
        {
          id: "decide",
          kind: "route",
          mode: "agent",
          actor: { agent: "aiden", mode: "readOnly", label: "router" },
          prompt: "Choose a route.",
          rules: [{ when: { source: "input.task", op: "exists" }, to: "left" }],
          routes: ["left", "right"]
        },
        { id: "left", kind: "task", mode: "program", dependsOn: ["decide"], operation: "command", command: "true" },
        { id: "right", kind: "task", mode: "program", dependsOn: ["decide"], operation: "command", command: "true" },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["left", "right"] }
      ]
    });

    const plan = compileExecutionPlan(spec);
    const routeStage = spec.stages.find((stage) => stage.id === "decide");

    expect(plan.stages.find((stage) => stage.id === "decide")?.agent?.implicitOutputFields).toEqual(["route:left|right"]);
    expect(plan.prompts.decide.footer).toContain("route: \"left\" | \"right\"");
    expect(plan.prompts.decide.footer).not.toContain("route:left|right");
    expect(routeStage ? renderStagePrompt(spec, routeStage) : "").toContain("route: \"left\" | \"right\"");
  });

  it("plans loop body prompts with loop-prefixed prompt ids", () => {
    const spec = WorkflowSpecSchema.parse({
      ...baseSpec(),
      root: "quality_loop",
      stages: [
        {
          id: "quality_loop",
          kind: "loop",
          maxRounds: 2,
          body: {
            root: "validate",
            output: "validate",
            stages: [{
              id: "validate",
              kind: "task",
              mode: "agent",
              actor: { agent: "aiden", mode: "readOnly", label: "validator" },
              prompt: "Validate"
            }]
          },
          continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
          onExhausted: "blocked"
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["quality_loop"] }
      ]
    });
    const plan = compileExecutionPlan(spec);

    expect(plan.stages.find((stage) => stage.id === "quality_loop")?.loop).toMatchObject({
      maxRounds: 2,
      body: { root: "validate", output: "validate" }
    });
    expect(plan.prompts.quality_loop__validate.footer).toContain("# Final Output Contract");
  });
});
