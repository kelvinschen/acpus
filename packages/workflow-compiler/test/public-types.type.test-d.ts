import { expectTypeOf, test } from "vitest";
import type {
  PreparedWorkflow,
  WorkflowPreparationLock,
  WorkflowPreparationOptions,
  WorkflowPreparationFailure,
} from "@acpus/workflow-compiler";
import { WorkflowPreparationError, prepareWorkflow, tryPrepareWorkflow } from "@acpus/workflow-compiler";
import type { ResultAsync } from "neverthrow";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(tryPrepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>>();

  expectTypeOf<WorkflowPreparationFailure["type"]>().toEqualTypeOf<"check-failed" | "compile-failed" | "validate-failed">();
  expectTypeOf<WorkflowPreparationFailure["phase"]>().toEqualTypeOf<"check" | "compile" | "validate">();
  expectTypeOf<PreparedWorkflow["lock"]>().toEqualTypeOf<WorkflowPreparationLock>();

  const error = new WorkflowPreparationError({ type: "compile-failed", phase: "compile", message: "failed" });
  expectTypeOf(error.failure).toEqualTypeOf<WorkflowPreparationFailure>();
});
