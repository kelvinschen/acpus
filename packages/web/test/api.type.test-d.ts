import { expectTypeOf, test } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { ExprIR } from "@acpus/expression/ir";
import type { RunInspectionDetailedFailure } from "@acpus/runtime";
import { renderWorkflowVizHtml } from "@acpus/web";
import type {
  NodeInspectionFailure,
  WorkflowVisualizationResult,
} from "../src/client/api.js";

test("Web transport contracts preserve their semantic shapes", () => {
  type ReadyResult = Extract<WorkflowVisualizationResult, { status: "ready" }>;
  type FailedResult = Extract<WorkflowVisualizationResult, { status: "failed" }>;
  expectTypeOf<ReadyResult["contract"]["output"]>().toEqualTypeOf<ExprIR>();
  expectTypeOf<FailedResult["phase"]>().toEqualTypeOf<"source" | "check" | "compile" | "lock" | "validate">();
  expectTypeOf<NodeInspectionFailure>().toExtend<RunInspectionDetailedFailure>();
  expectTypeOf<RunInspectionDetailedFailure>().toExtend<NodeInspectionFailure>();
  expectTypeOf<Parameters<typeof renderWorkflowVizHtml>[0]>().toEqualTypeOf<{
    ir: WorkflowIR;
    sourceGraphDigest: string;
  }>();
});
