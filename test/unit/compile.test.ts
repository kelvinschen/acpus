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
    expect(plan.prompts.plan.footer).toContain("End the response with exactly one valid, parseable JSON object that satisfies the schema.");
    expect(plan.prompts.plan.footer).toContain("Do not wrap the final JSON object in Markdown code fences. Do not use ```json.");
    expect(plan.prompts.plan.footer).not.toContain("fenced JSON block tagged workflow-output");
    expect(plan.contracts.implement).toMatchObject({ name: "implementation" });
    expect(plan.contracts.validate).toMatchObject({ name: "validation" });
    expect(plan.contracts.gate).toMatchObject({ name: "gate" });
  });

  it("plans fanout item sessions independently", () => {
    const spec = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const plan = compileExecutionPlan(spec);
    const fanout = plan.stages.find((stage) => stage.id === "review_files");

    expect(fanout?.session).toEqual({ kind: "fanoutItem", template: "role:validator:fanout:review_files:item:{itemId}" });
    expect(fanout?.fanout).toMatchObject({
      itemsSource: "outputs.discover_changed_files.files",
      allowPartial: true,
      maxConcurrency: 4
    });
    expect(plan.fanout[0]).toMatchObject({
      stageId: "review_files",
      sessionKeyTemplate: "role:validator:fanout:review_files:item:{itemId}"
    });
  });

  it("keeps program decisions and reducers as runtime metadata", () => {
    const base = WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "workflows/examples/review-only-fanout.workflow.spec.json"), "utf8")));
    const spec = WorkflowSpecSchema.parse({
      ...base,
      limits: { ...base.limits, maxAgents: 26 },
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
    expect(plan.prompts.quality_loop__validate.footer).toContain("Minimal valid example");
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
      limits: { maxAgents: 1 },
      stages: [
        { id: "work", kind: "agentTask", role: "implementer", prompt: "Do work" },
        { id: "legacy_summary", kind: "summarize", role: "summarizer", dependsOn: ["work"], prompt: "Legacy summary" }
      ]
    });

    expect(() => compileExecutionPlan(spec)).toThrow(/Summarize stage legacy_summary is deprecated/);
  });
});
