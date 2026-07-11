import { describe, expect, it } from "vitest";
import * as core from "@acpus/core";
import * as ir from "@acpus/core/ir";
import * as runtime from "@acpus/core/runtime";
import * as schema from "@acpus/core/schema";
import * as workflow from "@acpus/core/workflow";
import { z as nativeZ } from "zod";

describe("@acpus/core public API", () => {
  it("keeps the root entrypoint focused on minimal workflow authoring", () => {
    expect(Object.keys(core).sort()).toEqual([
      "defineWorkflow",
      "task",
      "z",
    ]);
    expect(core.z).toBe(nativeZ);
  });

  it("exports schema helpers from the schema entrypoint", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "schemaToJsonSchema",
      "toSchemaIR",
      "tryToSchemaIR",
      "z",
    ]);
    expect(schema.z).toBe(nativeZ);
  });

  it("exports workflow helpers from the workflow entrypoint", () => {
    expect(Object.keys(workflow).sort()).toEqual([
      "compileWorkflowDefinition",
      "defineWorkflow",
      "isWorkflowDefinition",
    ]);
  });

  it("exports runtime helpers from the runtime entrypoint", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "createDollar",
    ]);
  });

  it("exports IR validation, duration parsing, and traversal from the IR entrypoint", () => {
    expect(Object.keys(ir).sort()).toEqual([
      "childScopes",
      "tryParseDurationMs",
      "validateWorkflowIR",
      "walkNodes",
    ]);
  });
});
