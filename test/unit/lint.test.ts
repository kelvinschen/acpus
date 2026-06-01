import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintWorkflowSpec } from "../../src/compiler/lint.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

const root = path.resolve(__dirname, "..", "..");

function example(name: string): WorkflowSpec {
  return WorkflowSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "workflows", "examples", name), "utf8")));
}

describe("compiler lint", () => {
  it("accepts simple feature example", () => {
    expect(lintWorkflowSpec(example("simple-feature.workflow.spec.json")).filter((entry) => entry.severity !== "warning")).toEqual([]);
  });

  it("warns for edit fanout but requires reconcile", () => {
    const spec = example("edit-fanout-reconcile.workflow.spec.json");
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("FANOUT_EDIT_HIGH_RISK");
    expect(issues.map((entry) => entry.code)).not.toContain("FANOUT_EDIT_RECONCILE_MISSING");
  });

  it("rejects undeclared prompt variables", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages[0] = { ...spec.stages[0], prompt: "Missing ${nope}" };
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("VARIABLE_UNDECLARED");
  });

  it("rejects non-decision branching before compile", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages.splice(2, 0, {
      id: "extra_validate",
      kind: "agentTask",
      role: "validator",
      dependsOn: ["implement"],
      variables: [{ name: "task", source: "input.task" }],
      prompt: "Validate ${task}"
    });
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_BRANCH_REQUIRES_DECISION_GATE");
  });

  it("requires root to name the single dependency-free stage", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.root = "implement";
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_ROOT_HAS_DEPENDENCIES");
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_ROOT_MISMATCH");
  });

  it("rejects edit roles for read-only orchestration stages", () => {
    const spec = example("review-only-fanout.workflow.spec.json");
    spec.roles.reviewer = { category: "implementation", agent: "trae", mode: "edit" };
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("ROLE_MODE_CONFLICT");
  });

  it("rejects workflows whose planned worst-case agent calls exceed maxAgents", () => {
    const spec = example("review-only-fanout.workflow.spec.json");
    spec.limits.maxAgents = 1;
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("LIMIT_MAX_AGENTS_EXCEEDED");
  });

  it("requires decision targets to be downstream of the gate", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages.splice(2, 0, {
      id: "gate",
      kind: "decisionGate",
      mode: "program",
      dependsOn: ["implement"],
      rules: [{ when: { source: "outputs.implement.status", op: "eq", value: "completed" }, to: "plan" }],
      default: "blocked"
    });
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("DECISION_TARGET_DEPENDENCY_UNSATISFIED");
  });

  it("validates fixLoop validator and fixer prompt variables", () => {
    const spec = example("bugfix-fixloop.workflow.spec.json");
    const loop = spec.stages.find((stage) => stage.kind === "fixLoop");
    if (loop?.kind !== "fixLoop") throw new Error("missing fixLoop example");
    loop.validator.prompt = "Missing ${undeclared}";
    const issues = lintWorkflowSpec(spec);
    expect(issues.some((entry) => entry.code === "VARIABLE_UNDECLARED" && entry.path.endsWith("/validator/prompt"))).toBe(true);
  });
});
