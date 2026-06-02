import { describe, expect, it } from "vitest";
import { applyInputDefaults, validateInputDefaults, validateWorkflowInput } from "../../src/schema/input-validation.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("input validation", () => {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "input-contract",
    root: "gate",
    inputs: {
      task: { type: "string", default: "" },
      paths: { type: "array<path>", default: [] }
    },
    roles: {
      gater: { category: "summarization", agent: "claude", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 2 },
    stages: [
      {
        id: "gate",
        kind: "gate",
        role: "gater",
        variables: [{ name: "task", source: "input.task" }],
        prompt: "Gate ${task}"
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
