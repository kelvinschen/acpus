import { describe, expect, it } from "vitest";
import { applyInputDefaults, validateInputDefaults, validateWorkflowInput } from "../../src/schema/input-validation.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("input validation", () => {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "input-contract",
    root: "summarize",
    inputs: {
      task: { type: "string", default: "" },
      paths: { type: "array<path>", default: [] }
    },
    roles: {
      summarizer: { category: "summarization", agent: "claude", mode: "readOnly" }
    },
    limits: { maxAgents: 2 },
    stages: [
      {
        id: "summarize",
        kind: "summarize",
        role: "summarizer",
        variables: [{ name: "task", source: "input.task" }],
        prompt: "Summarize ${task}"
      }
    ]
  });

  it("merges declared defaults with runtime input", () => {
    expect(applyInputDefaults(spec, { task: "run" })).toEqual({ task: "run", paths: [] });
  });

  it("rejects invalid default values", () => {
    const invalid = WorkflowSpecSchema.parse({
      ...spec,
      inputs: { task: { type: "string", default: 1 } }
    });
    expect(validateInputDefaults(invalid).map((entry) => entry.code)).toContain("SCHEMA_INPUT_DEFAULT_TYPE_INVALID");
  });

  it("validates runtime input values and warns on unknown inputs", () => {
    const issues = validateWorkflowInput(spec, { task: 1, extra: true });
    expect(issues.map((entry) => entry.code)).toContain("SCHEMA_INPUT_TYPE_INVALID");
    expect(issues.map((entry) => entry.code)).toContain("SCHEMA_INPUT_UNKNOWN");
  });
});
