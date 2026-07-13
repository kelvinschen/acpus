import { expectTypeOf, test } from "vitest";
import type { ExprIR } from "@acpus/expression/ir";
import type { WorkflowVisualizationResult } from "../src/client/api.js";

test("static workflow output contract remains an ExprIR", () => {
  type ReadyResult = Extract<WorkflowVisualizationResult, { status: "ready" }>;
  expectTypeOf<ReadyResult["contract"]["output"]>().toEqualTypeOf<ExprIR>();
});
