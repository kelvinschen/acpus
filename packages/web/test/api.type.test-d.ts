import { expectTypeOf, test } from "vitest";
import type { ExprIR } from "@acpus/expression/ir";
import type {
  NodeExecutionInspection as ClientNodeExecutionInspection,
  WorkflowVisualizationResult,
} from "../src/client/api.js";
import type { NodeExecutionInspection as ServerNodeExecutionInspection } from "../src/server/node-inspection.js";
import type { WorkflowVisualizationResult as ServerWorkflowVisualizationResult } from "../src/server/workflows.js";

test("client and server share the Web transport contracts", () => {
  type ReadyResult = Extract<WorkflowVisualizationResult, { status: "ready" }>;
  type FailedResult = Extract<WorkflowVisualizationResult, { status: "failed" }>;
  expectTypeOf<ReadyResult["contract"]["output"]>().toEqualTypeOf<ExprIR>();
  expectTypeOf<FailedResult["phase"]>().toEqualTypeOf<"source" | "check" | "compile" | "lock" | "validate">();
  expectTypeOf<ServerWorkflowVisualizationResult>().toEqualTypeOf<WorkflowVisualizationResult>();
  expectTypeOf<ServerNodeExecutionInspection>().toEqualTypeOf<ClientNodeExecutionInspection>();
});
