import { describe, expect, it } from "vitest";
import * as core from "@acpus/core";
import * as expression from "@acpus/core/expression";
import * as ir from "@acpus/core/ir";
import * as runtime from "@acpus/core/runtime";
import * as schema from "@acpus/core/schema";
import * as workflow from "@acpus/core/workflow";

describe("@acpus/core public API", () => {
  it("keeps the root entrypoint focused on minimal workflow authoring", () => {
    expect(Object.keys(core).sort()).toEqual([
      "defineWorkflow",
      "runtime",
      "s",
      "secret",
      "task",
      "template",
      "z",
    ]);
  });

  it("exports expression helpers from the expression entrypoint", () => {
    expect(Object.keys(expression).sort()).toEqual([
      "all",
      "and",
      "any",
      "coalesce",
      "endsWith",
      "eq",
      "expr",
      "exprOps",
      "fallback",
      "gt",
      "gte",
      "head",
      "includes",
      "isEmpty",
      "isExpr",
      "len",
      "literal",
      "lt",
      "lte",
      "matches",
      "max",
      "min",
      "ne",
      "not",
      "nth",
      "or",
      "pick",
      "refExpr",
      "startsWith",
      "valueToExprIR",
      "where",
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
      "runtime",
      "secret",
    ]);
  });

  it("exports IR validation from the IR entrypoint", () => {
    expect(Object.keys(ir).sort()).toEqual(["validateWorkflowIR"]);
  });
});
