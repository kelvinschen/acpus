import { describe, expect, it } from "vitest";
import * as core from "@acpus/core";
import * as ir from "@acpus/core/ir";
import * as runtime from "@acpus/core/runtime";
import * as schema from "@acpus/core/schema";
import * as workflow from "@acpus/core/workflow";

describe("@acpus/core public API", () => {
  it("keeps the root entrypoint focused on minimal workflow authoring", () => {
    expect(Object.keys(core).sort()).toEqual([
      "defineWorkflow",
      "s",
      "secret",
      "task",
      "z",
    ]);
  });

  it("exports schema helpers from the schema entrypoint", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "assertBoundarySchema",
      "isSchema",
      "parseSchema",
      "s",
      "safeParseSchema",
      "schemaToJsonSchema",
      "toJSONSchema",
      "toSchemaIR",
      "tryToSchemaIR",
      "validateValue",
      "z",
    ]);
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
      "secret",
    ]);
  });

  it("exports IR validation from the IR entrypoint", () => {
    expect(Object.keys(ir).sort()).toEqual(["validateWorkflowIR"]);
  });
});
