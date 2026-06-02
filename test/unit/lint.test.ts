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
    const spec = example("fanout/edit-only-single-lane.workflow.spec.json");
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("FANOUT_EDIT_HIGH_RISK");
    expect(issues.map((entry) => entry.code)).not.toContain("FANOUT_EDIT_RECONCILE_MISSING");
  });

  it("validates heterogeneous fanout lane group rules", () => {
    const spec = example("fanout/read-only-single-lane.workflow.spec.json");
    const fanout = spec.stages.find((stage) => stage.kind === "fanout");
    if (fanout?.kind !== "fanout") throw new Error("missing fanout");
    fanout.laneGroups = [
      {
        id: "route",
        mode: "oneOf",
        lanes: [
          { id: "a", role: "validator" },
          { id: "b", role: "validator", default: true, when: { source: "item.area", op: "eq", value: "docs" } },
          { id: "c", role: "validator", default: true }
        ]
      },
      { id: "route", mode: "all", lanes: [{ id: "a", role: "validator", default: true }] }
    ];

    const codes = lintWorkflowSpec(spec).map((entry) => entry.code);
    expect(codes).toContain("FANOUT_LANE_GROUP_DUPLICATE");
    expect(codes).toContain("FANOUT_ONE_OF_WHEN_REQUIRED");
    expect(codes).toContain("FANOUT_ONE_OF_DEFAULT_DUPLICATE");
    expect(codes).toContain("FANOUT_DEFAULT_WHEN_INVALID");
    expect(codes).toContain("FANOUT_DEFAULT_INVALID");
  });

  it("rejects fanout lanes with mismatched inferred contracts", () => {
    const spec = example("fanout/read-only-single-lane.workflow.spec.json");
    spec.roles.implementer = { category: "implementation", agent: "codex", mode: "edit" };
    const fanout = spec.stages.find((stage) => stage.kind === "fanout");
    if (fanout?.kind !== "fanout") throw new Error("missing fanout");
    fanout.laneGroups[0].lanes.push({ id: "implementer", role: "implementer" });

    expect(lintWorkflowSpec(spec).map((entry) => entry.code)).toContain("FANOUT_CONTRACT_MISMATCH");
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
    const spec = example("fanout/read-only-single-lane.workflow.spec.json");
    spec.roles.reviewer = { category: "implementation", agent: "trae", mode: "edit" };
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("ROLE_MODE_CONFLICT");
  });

  it("rejects stage concurrency on non-fanout stages", () => {
    const spec = example("fanout/read-only-single-lane.workflow.spec.json");
    const reduce = spec.stages.find((stage) => stage.id === "reduce_findings");
    if (!reduce) throw new Error("missing reduce");
    reduce.limits = { maxConcurrency: 2 };
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("LIMIT_STAGE_CONCURRENCY_UNSUPPORTED");
  });

  it("rejects removed limit fields during schema validation", () => {
    const spec = example("simple-feature.workflow.spec.json");
    expect(() => WorkflowSpecSchema.parse({ ...spec, limits: { ...spec.limits, maxAgents: 1 } })).toThrow();
    expect(() => WorkflowSpecSchema.parse({ ...spec, limits: { ...spec.limits, maxConcurrency: 2 } })).toThrow();
    expect(() => WorkflowSpecSchema.parse({ ...spec, limits: { ...spec.limits, maxFanoutItems: 2 } })).toThrow();
    expect(() => WorkflowSpecSchema.parse({ ...spec, limits: { ...spec.limits, maxFixRounds: 1 } })).toThrow();
    expect(() => WorkflowSpecSchema.parse({ ...spec, limits: { ...spec.limits, maxOutputChars: 1000 } })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      ...spec,
      stages: spec.stages.map((stage) => stage.id === "plan" ? { ...stage, limits: { maxAgents: 1 } } : stage)
    })).toThrow();
  });

  it("requires decision targets to be downstream of the decision gate", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages.splice(2, 0, {
      id: "decide",
      kind: "decisionGate",
      mode: "program",
      dependsOn: ["implement"],
      rules: [{ when: { source: "outputs.implement.status", op: "eq", value: "completed" }, to: "plan" }],
      default: "blocked"
    });
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("DECISION_TARGET_DEPENDENCY_UNSATISFIED");
  });

  it("requires exactly one terminal gate", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages = spec.stages.filter((stage) => stage.kind !== "gate");
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_GATE_COUNT_INVALID");
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_NON_GATE_TERMINAL");
  });

  it("rejects deprecated summarize stages with migration guidance", () => {
    const spec = example("simple-feature.workflow.spec.json");
    spec.stages.push({ id: "legacy_summary", kind: "summarize", role: "summarizer", dependsOn: ["gate"], prompt: "legacy" });
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("GRAPH_SUMMARIZE_DEPRECATED");
  });

  it("requires explicit conditions for ambiguous program gates", () => {
    const spec = example("simple-feature.workflow.spec.json");
    const gate = spec.stages.find((stage) => stage.kind === "gate");
    if (gate?.kind !== "gate") throw new Error("missing gate");
    gate.dependsOn = ["plan", "implement"];
    const issues = lintWorkflowSpec(spec);
    expect(issues.map((entry) => entry.code)).toContain("GATE_PROGRAM_CONDITION_REQUIRED");
  });

  it("validates fixLoop validator and fixer prompt variables", () => {
    const spec = example("bugfix-fixloop.workflow.spec.json");
    const loop = spec.stages.find((stage) => stage.kind === "fixLoop");
    if (loop?.kind !== "fixLoop") throw new Error("missing fixLoop example");
    loop.validator.prompt = "Missing ${undeclared}";
    const issues = lintWorkflowSpec(spec);
    expect(issues.some((entry) => entry.code === "VARIABLE_UNDECLARED" && entry.path.endsWith("/validator/prompt"))).toBe(true);
  });

  it("validates condition in operator value shape during schema parsing", () => {
    const spec = example("simple-feature.workflow.spec.json");
    const gate = spec.stages.find((stage) => stage.kind === "gate");
    if (gate?.kind !== "gate") throw new Error("missing gate");

    expect(() => WorkflowSpecSchema.parse({
      ...spec,
      stages: spec.stages.map((stage) => stage.id === gate.id ? {
        ...stage,
        condition: { source: "outputs.implement.status", op: "in", value: ["completed", "blocked"] }
      } : stage)
    })).not.toThrow();
    expect(() => WorkflowSpecSchema.parse({
      ...spec,
      stages: spec.stages.map((stage) => stage.id === gate.id ? {
        ...stage,
        condition: { source: "outputs.implement.status", op: "in", value: "completed" }
      } : stage)
    })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      ...spec,
      stages: spec.stages.map((stage) => stage.id === gate.id ? {
        ...stage,
        condition: { source: "outputs.implement.status", op: "in" }
      } : stage)
    })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      ...spec,
      stages: spec.stages.map((stage) => stage.id === gate.id ? {
        ...stage,
        condition: { all: [
          { source: "outputs.implement.status", op: "exists" },
          { source: "outputs.implement.blockedReason", op: "empty" }
        ] }
      } : stage)
    })).not.toThrow();
  });
});
