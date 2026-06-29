import { expectTypeOf, test } from "vitest";
import type {
  CompileOptions,
  PreparedWorkflow,
  PreflightArtifact,
  PreflightOptions,
  WorkflowLockArtifact,
  WorkflowPreparationFailure,
} from "@acpus/workflow-compiler";
import { WorkflowPreparationError, compileWorkflowModule, prepareWorkflow, writePreflightArtifact } from "@acpus/workflow-compiler";
import type { WorkflowIR } from "@acpus/core";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(compileWorkflowModule).toEqualTypeOf<(entry: string, options?: CompileOptions) => Promise<WorkflowIR>>();
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: PreflightOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(writePreflightArtifact).toEqualTypeOf<(prepared: PreparedWorkflow, cwd: string) => Promise<PreflightArtifact>>();

  expectTypeOf<CompileOptions>().toEqualTypeOf<{
    sourcePath?: string;
    cwd?: string;
    conditions?: string[];
  }>();
  expectTypeOf<WorkflowPreparationFailure["phase"]>().toEqualTypeOf<"typecheck" | "compile" | "validate">();
  expectTypeOf<PreparedWorkflow["lock"]>().toEqualTypeOf<WorkflowLockArtifact>();
  expectTypeOf<PreflightArtifact>().toEqualTypeOf<{ dir: string }>();

  const error = new WorkflowPreparationError({ phase: "compile", message: "failed" });
  expectTypeOf(error.failure).toEqualTypeOf<WorkflowPreparationFailure>();
});
