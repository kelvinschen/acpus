import { expectTypeOf, test } from "vitest";
import type {
  PreparedWorkflow,
  CompileWorkerFailure,
  PackageLockFailure,
  WorkflowPreparationLock,
  WorkflowPreparationOptions,
  WorkflowPreparationFailure,
  WorkflowMetadata,
  WorkflowMetadataError,
} from "@acpus/workflow-compiler";
import { WorkflowPreparationError, extractWorkflowMetadata, prepareWorkflow, tryPrepareWorkflow } from "@acpus/workflow-compiler";
import type { ResultAsync } from "neverthrow";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(tryPrepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>>();
  expectTypeOf(extractWorkflowMetadata).toEqualTypeOf<(source: string, fileName: string) => ResultAsync<WorkflowMetadata, WorkflowMetadataError>>();

  expectTypeOf<WorkflowPreparationFailure["type"]>().toEqualTypeOf<"check-failed" | "compile-failed" | "package-lock-read-failed" | "validate-failed">();
  expectTypeOf<WorkflowPreparationFailure["phase"]>().toEqualTypeOf<"check" | "compile" | "lock" | "validate">();
  expectTypeOf<PreparedWorkflow["lock"]>().toEqualTypeOf<WorkflowPreparationLock>();
  expectTypeOf<PackageLockFailure["type"]>().toEqualTypeOf<"package-lock-read-failed">();
  expectTypeOf<Extract<CompileWorkerFailure, { type: "worker-spawn-failed" }>[
    "stdoutTail"
  ]>().toEqualTypeOf<string>();

  const failure = { type: "worker-system-failed", message: "failed" } satisfies CompileWorkerFailure;
  const error = new WorkflowPreparationError({ type: "compile-failed", phase: "compile", message: "failed", failure });
  expectTypeOf(error.failure).toEqualTypeOf<WorkflowPreparationFailure>();
});
