import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileExecutionPlan } from "../../src/compiler/compile.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("compileExecutionPlan", () => {
  it("creates a stable runtime execution plan without TypeScript flow source", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const plan = compileExecutionPlan(spec);

    expect(plan.version).toBe("acpx-workflow-orchestrator.execution-plan/v1");
    expect(plan.workflowName).toBe("simple-feature");
    expect(plan.stages.map((stage) => stage.id)).toEqual(["plan", "implement", "validate", "gate"]);
    expect(JSON.stringify(plan)).not.toContain("defineFlow");
    expect(JSON.stringify(plan)).not.toContain("workflow.flow.ts");
    expect(plan.prompts.plan.footer).toContain("**Workflow Stage Contract**");
    expect(plan.prompts.plan.footer).toContain("Stage contract:");
    expect(plan.prompts.plan.footer).toContain("- Do not edit production files in this stage.");
    expect(plan.prompts.plan.footer).toContain("Output contract:");
    expect(plan.prompts.plan.footer).toContain("**Response with exactly one valid, parseable JSON object that satisfies the schema**.");
    expect(plan.prompts.plan.footer).toContain("Do not wrap the final JSON object in Markdown code fences, especially ```json.");
    expect(plan.prompts.plan.footer).not.toContain("Minimal valid example");
    expect(plan.prompts.plan.footer).not.toContain("Allowed deterministic alias");
    expect(plan.prompts.plan.footer).not.toContain("fenced JSON block tagged workflow-output");
    expect(plan.contracts.implement).toMatchObject({ name: "implementation" });
    expect(plan.contracts.validate).toMatchObject({ name: "validation" });
    expect(plan.contracts.gate).toMatchObject({ name: "gate" });
  });

  it("plans fanout item sessions independently", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/fanout/read-only-single-lane.workflow.spec.json"), "utf8")));
    const plan = compileExecutionPlan(spec);
    const fanout = plan.stages.find((stage) => stage.id === "review_files");

    expect(fanout?.session).toEqual({ kind: "fanoutItem", template: "fanout:review_files:item:{itemId}:group:{groupId}:lane:{laneId}" });
    expect(fanout?.fanout).toMatchObject({
      itemsSource: "outputs.discover_changed_files.files",
      allowPartial: true,
      maxConcurrency: 4
    });
    expect(fanout?.fanout?.laneGroups[0].lanes[0]).toMatchObject({
      roleName: "validator",
      sessionKeyTemplate: "role:validator:fanout:review_files:item:{itemId}:group:review:lane:validator"
    });
    expect(plan.fanout[0]).toMatchObject({
      stageId: "review_files"
    });
  });

  it("plans heterogeneous fanout lane groups with inherited and overridden prompts", () => {
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "heterogeneous",
      root: "review",
      inputs: { items: { type: "array<json>", default: [] } },
      roles: {
        codex: { category: "review", agent: "codex", mode: "readOnly" },
        claude: { category: "review", agent: "claude", mode: "readOnly" }
      },
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          prompt: "Review ${item.path}",
          variables: [{ name: "path", source: "item.path" }],
          laneGroups: [
            {
              id: "cross",
              mode: "all",
              lanes: [
                { id: "codex", role: "codex" },
                { id: "claude", role: "claude", prompt: "Claude review ${path}" }
              ]
            }
          ]
        },
        { id: "gate", kind: "gate", dependsOn: ["review"] }
      ]
    });
    const plan = compileExecutionPlan(spec);
    const fanout = plan.stages.find((stage) => stage.id === "review");

    expect(fanout?.fanout?.laneGroups[0].lanes.map((lane) => [lane.id, lane.roleName, lane.promptId])).toEqual([
      ["codex", "codex", "review__cross__codex"],
      ["claude", "claude", "review__cross__claude"]
    ]);
    expect(plan.prompts.review__cross__codex.template).toBe("Review ${item.path}");
    expect(plan.prompts.review__cross__claude.template).toBe("Claude review ${path}");
  });

  it("defaults fanout concurrency and item caps to one when omitted", () => {
    const base = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/fanout/read-only-single-lane.workflow.spec.json"), "utf8")));
    const spec = WorkflowSpecSchema.parse({
      ...base,
      stages: base.stages.map((stage) => stage.id === "review_files" ? { ...stage, limits: undefined } : stage)
    });
    const plan = compileExecutionPlan(spec);
    const fanout = plan.stages.find((stage) => stage.id === "review_files");

    expect(fanout?.fanout).toMatchObject({
      maxConcurrency: 1,
      maxItems: 1
    });
    expect(plan.limits.stageTimeoutMinutes).toBe(45);
    expect(plan.limits).not.toHaveProperty("maxAgents");
    expect(plan.limits).not.toHaveProperty("maxConcurrency");
    expect(plan.limits).not.toHaveProperty("maxFanoutItems");
    expect(plan.limits).not.toHaveProperty("maxFixRounds");
  });

  it("keeps program decisions and reducers as runtime metadata", () => {
    const base = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/fanout/read-only-single-lane.workflow.spec.json"), "utf8")));
    const spec = WorkflowSpecSchema.parse({
      ...base,
      limits: { ...base.limits },
      stages: base.stages.map((stage) => stage.id === "reduce_findings"
        ? { id: "reduce_findings", kind: "reduce", mode: "program", from: "review_files", dependsOn: ["review_files"], operation: "dedupeFindings" }
        : stage)
    });
    const plan = compileExecutionPlan(spec);

    expect(plan.stages.find((stage) => stage.id === "reduce_findings")?.reduce).toMatchObject({
      mode: "program",
      from: "review_files",
      operation: "dedupeFindings"
    });
  });

  it("plans fixLoop validator and fixer prompts without old flow routes", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/bugfix-fixloop.workflow.spec.json"), "utf8")));
    const plan = compileExecutionPlan(spec);
    const loop = plan.stages.find((stage) => stage.id === "quality_loop");

    expect(loop?.fixLoop).toMatchObject({
      maxRounds: 2,
      validator: { roleName: "validator", promptId: "quality_loop__validate", contract: { name: "validation" } },
      fixer: { roleName: "implementer", promptId: "quality_loop__fix", contract: { name: "implementation" } }
    });
    expect(plan.prompts.quality_loop__validate.footer).toContain("Output contract:");
    expect(plan.prompts.quality_loop__validate.footer).not.toContain("Minimal valid example");
    expect(plan.prompts.quality_loop__validate.footer).not.toContain("Allowed deterministic alias");
    expect(JSON.stringify(plan)).not.toContain("__blocked_stop");
  });

  it("fails fast if a deprecated summarize stage reaches compile", () => {
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "legacy-summarize",
      root: "work",
      roles: {
        implementer: { category: "implementation", agent: "codex", mode: "edit" },
        summarizer: { category: "summarization", agent: "codex", mode: "readOnly" }
      },
      limits: { stageTimeoutMinutes: 1 },
      stages: [
        { id: "work", kind: "agentTask", role: "implementer", prompt: "Do work" },
        { id: "legacy_summary", kind: "summarize", role: "summarizer", dependsOn: ["work"], prompt: "Legacy summary" }
      ]
    });

    expect(() => compileExecutionPlan(spec)).toThrow(/Summarize stage legacy_summary is deprecated/);
  });
});
