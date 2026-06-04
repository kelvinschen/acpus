import { describe, expect, it } from "vitest";
import { applyInputDefaults, validateInputSchema, validateWorkflowInput } from "../../src/schema/input-validation.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("input validation", () => {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "input-contract",
    root: "gate",
    input: {
      schema: "{task:string,paths:[string],options?:{fast:boolean}}",
      default: { task: "", paths: [] }
    },
    limits: { stageTimeoutMinutes: 2 },
    stages: [
      {
        id: "gate",
        kind: "gate",
        mode: "agent",
        actor: { agent: "claude", mode: "readOnly", label: "gater" },
        variables: [{ name: "task", source: "input.task" }],
        prompt: "Gate ${task}"
      }
    ]
  });

  it("shallow-merges declared defaults with runtime input", () => {
    expect(applyInputDefaults(spec, { task: "run" })).toEqual({ task: "run", paths: [] });
  });

  it("rejects invalid default values", () => {
    const invalid = WorkflowSpecSchema.parse({
      ...spec,
      input: { schema: "{task:string}", default: { task: 1 } }
    });
    expect(validateInputSchema(invalid).map((entry) => entry.code)).toContain("INPUT_DEFAULT_SCHEMA_INVALID");
  });

  it("rejects invalid input schema DSL", () => {
    const invalid = WorkflowSpecSchema.parse({
      ...spec,
      input: { schema: "{task:Record}" }
    });
    expect(validateInputSchema(invalid).map((entry) => entry.code)).toContain("INPUT_SCHEMA_DSL_INVALID");
  });

  it("validates runtime input values and rejects unknown inputs", () => {
    const issues = validateWorkflowInput(spec, { task: 1, paths: [], extra: true });
    expect(issues.map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
    expect(issues.map((entry) => entry.code)).toContain("INPUT_UNKNOWN");
  });

  it("requires declared non-optional fields", () => {
    expect(validateWorkflowInput(spec, { paths: [] }).map((entry) => entry.code)).toContain("INPUT_REQUIRED");
  });

  it("strictly validates nested object fields", () => {
    expect(validateWorkflowInput(spec, { task: "run", paths: [], options: { fast: true, extra: true } }).map((entry) => entry.code)).toContain("INPUT_UNKNOWN");
  });

  it("validates review item arrays structurally", () => {
    const reviewSpec = WorkflowSpecSchema.parse({
      ...spec,
      input: {
        schema: "{reviewItems:[{id:string,scope:string,files:[string]}]}"
      }
    });

    expect(validateWorkflowInput(reviewSpec, {
      reviewItems: [{ id: "schema-compiler", scope: "Schema and compiler", files: ["src/schema/workflow-spec.ts"] }]
    })).toEqual([]);
    expect(validateWorkflowInput(reviewSpec, {
      reviewItems: [{ id: "schema-compiler", scope: "Schema and compiler", files: [1] }]
    }).map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
  });

  it("validates input-sourced limits after runtime input schema validation", () => {
    const limitSpec = WorkflowSpecSchema.parse({
      ...spec,
      input: {
        schema: "{task:string,paths:[string],maxConcurrency?:unknown,maxFanoutItems?:number,timeout?:number}",
        default: { task: "", paths: [] }
      },
      limits: {
        stageTimeoutMinutes: { source: "input.timeout", default: 2 }
      },
      stages: [
        {
          id: "fanout",
          kind: "fanout",
          items: { source: "input.paths" },
          prompt: "Review",
          limits: {
            maxConcurrency: { source: "input.maxConcurrency" },
            maxFanoutItems: { source: "input.maxFanoutItems", default: 4 }
          },
          lanes: [
            { id: "reviewer", actor: { agent: "aiden", mode: "readOnly" } }
          ],
          fanin: { mode: "program", operation: "mergeArrays" }
        },
        { id: "gate", kind: "gate", dependsOn: ["fanout"] }
      ],
      root: "fanout"
    });

    expect(validateWorkflowInput(limitSpec, {
      task: "run",
      paths: [],
      maxConcurrency: 3
    })).toEqual([]);
    expect(validateWorkflowInput(limitSpec, {
      task: "run",
      paths: []
    }).map((entry) => entry.code)).toContain("INPUT_REQUIRED");
    expect(validateWorkflowInput(limitSpec, {
      task: "run",
      paths: [],
      maxConcurrency: "3"
    }).map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
    expect(validateWorkflowInput(limitSpec, {
      task: "run",
      paths: [],
      maxConcurrency: 0
    }).map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
    expect(validateWorkflowInput(limitSpec, {
      task: "run",
      paths: [],
      maxConcurrency: 1.5
    }).map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
  });

  it("rejects non-input limit sources", () => {
    const invalid = WorkflowSpecSchema.parse({
      ...spec,
      limits: { stageTimeoutMinutes: { source: "outputs.plan.timeout" } }
    });

    expect(validateWorkflowInput(invalid, { task: "", paths: [] }).map((entry) => entry.code)).toContain("INPUT_SCHEMA_INVALID");
  });
});
