import { expectTypeOf, test } from "vitest";
import type {
  CompileWorkerFailure,
  PackageLockFailure,
  PreparedWorkflow,
  Sha256Digest,
  WorkflowMetadata,
  WorkflowMetadataError,
  WorkflowPreparationFailure,
  WorkflowPreparationLock,
  WorkflowPreparationOptions,
  WorkflowSourceBundle,
  WorkflowSourceFile,
  WorkflowSourceInput,
  WorkflowSourceRef,
} from "@acpus/workflow-compiler";
import {
  WorkflowPreparationError,
  extractWorkflowMetadata,
  prepareWorkflow,
  tryPrepareWorkflow,
} from "@acpus/workflow-compiler";
import type * as Effect from "effect/Effect";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(tryPrepareWorkflow).toEqualTypeOf<
    (options: WorkflowPreparationOptions) => Effect.Effect<PreparedWorkflow, WorkflowPreparationFailure>
  >();
  expectTypeOf(extractWorkflowMetadata).toEqualTypeOf<
    (source: string, fileName: string) => Effect.Effect<WorkflowMetadata, WorkflowMetadataError>
  >();

  expectTypeOf<Sha256Digest>().toEqualTypeOf<`sha256:${string}`>();
  expectTypeOf<WorkflowSourceFile>().toEqualTypeOf<{ path: string; content: string }>();
  expectTypeOf<WorkflowPreparationOptions>().toEqualTypeOf<{
    workspaceDir: string;
    source: WorkflowSourceInput;
  }>();
  expectTypeOf<WorkflowSourceInput>().toEqualTypeOf<
    | { kind: "path"; entry: string }
    | { kind: "files"; entry: string; files: readonly WorkflowSourceFile[] }
  >();
  expectTypeOf<WorkflowSourceRef>().toEqualTypeOf<
    | { kind: "workspace"; entry: string }
    | { kind: "snapshot"; entry: string; digest: Sha256Digest }
  >();
  expectTypeOf<WorkflowSourceBundle>().toEqualTypeOf<{
    kind: "acpus_workflow_source_bundle";
    version: 1;
    files: readonly WorkflowSourceFile[];
  }>();
  expectTypeOf<WorkflowPreparationFailure["type"]>().toEqualTypeOf<
    "source-invalid" | "source-changed" | "check-failed" | "compile-failed" | "package-lock-read-failed" | "validate-failed"
  >();
  expectTypeOf<WorkflowPreparationFailure["phase"]>().toEqualTypeOf<"source" | "check" | "compile" | "lock" | "validate">();
  expectTypeOf<PreparedWorkflow["lock"]>().toEqualTypeOf<WorkflowPreparationLock>();
  expectTypeOf<PackageLockFailure["type"]>().toEqualTypeOf<"package-lock-read-failed">();
  expectTypeOf<Extract<CompileWorkerFailure, { type: "worker-spawn-failed" }>["stdoutTail"]>().toEqualTypeOf<string>();
  expectTypeOf<Extract<CompileWorkerFailure, { type: "workflow-source-changed" }>>()
    .toEqualTypeOf<{ type: "workflow-source-changed"; entry: string; message: string }>();

  const failure = { type: "worker-system-failed", message: "failed" } satisfies CompileWorkerFailure;
  const error = new WorkflowPreparationError({ type: "compile-failed", phase: "compile", message: "failed", failure });
  expectTypeOf(error.failure).toEqualTypeOf<WorkflowPreparationFailure>();

  const narrowPrepared = (prepared: PreparedWorkflow): void => {
    if (prepared.sourceBundle === undefined) {
      expectTypeOf(prepared.source).toEqualTypeOf<{ kind: "workspace"; entry: string }>();
      expectTypeOf(prepared.sourceBundle).toEqualTypeOf<undefined>();
    } else {
      expectTypeOf(prepared.source).toEqualTypeOf<{
        kind: "snapshot";
        entry: string;
        digest: Sha256Digest;
      }>();
      expectTypeOf(prepared.sourceBundle).toEqualTypeOf<WorkflowSourceBundle>();
    }
  };
  expectTypeOf(narrowPrepared).toEqualTypeOf<(prepared: PreparedWorkflow) => void>();
});
