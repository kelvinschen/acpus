import { expectTypeOf, test } from "vitest";
import type {
  CompileWorkflowModuleError,
  CompileOptions,
  PreparedWorkflow,
  WorkflowPreparationLock,
  WorkflowPreparationOptions,
  WorkflowPreparationFailure,
} from "@acpus/workflow-compiler";
import { WorkflowPreparationError, compileWorkflowModule, prepareWorkflow, tryCompileWorkflowModule, tryPrepareWorkflow } from "@acpus/workflow-compiler";
import type { WorkflowIR } from "@acpus/core/ir";
import type { ResultAsync } from "neverthrow";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(compileWorkflowModule).toEqualTypeOf<(entry: string, options?: CompileOptions) => Promise<WorkflowIR>>();
  expectTypeOf(tryCompileWorkflowModule).toEqualTypeOf<(entry: string, options?: CompileOptions) => ResultAsync<WorkflowIR, CompileWorkflowModuleError>>();
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(tryPrepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>>();

  expectTypeOf<CompileOptions>().toEqualTypeOf<{
    sourcePath?: string;
    cwd?: string;
  }>();
  expectTypeOf<CompileWorkflowModuleError["type"]>().toEqualTypeOf<
    "workflow-source-read-failed" | "module-import-failed" | "invalid-default-export" | "workflow-build-failed" | "task-analysis-failed" | "workflow-outside-workspace"
  >();
  expectTypeOf<WorkflowPreparationFailure["type"]>().toEqualTypeOf<"check-failed" | "compile-failed" | "validate-failed">();
  expectTypeOf<WorkflowPreparationFailure["phase"]>().toEqualTypeOf<"check" | "compile" | "validate">();
  expectTypeOf<PreparedWorkflow["lock"]>().toEqualTypeOf<WorkflowPreparationLock>();

  const error = new WorkflowPreparationError({ type: "compile-failed", phase: "compile", message: "failed" });
  expectTypeOf(error.failure).toEqualTypeOf<WorkflowPreparationFailure>();
});
