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
import type { ResultAsync } from "neverthrow";

test("@acpus/workflow-compiler public types describe the package boundary", () => {
  expectTypeOf(prepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => Promise<PreparedWorkflow>>();
  expectTypeOf(tryPrepareWorkflow).toEqualTypeOf<(options: WorkflowPreparationOptions) => ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>>();
  expectTypeOf(extractWorkflowMetadata).toEqualTypeOf<(source: string, fileName: string) => ResultAsync<WorkflowMetadata, WorkflowMetadataError>>();

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

  const files: WorkflowPreparationOptions = {
    workspaceDir: "/workspace",
    source: {
      kind: "files",
      entry: "workflow.ts",
      files: [{ path: "workflow.ts", content: "export default workflow;" }],
    },
  };
  expectTypeOf(files).toEqualTypeOf<WorkflowPreparationOptions>();

  const prepared = {} as PreparedWorkflow;
  // @ts-expect-error prepared workflows no longer expose the original workflowPath field.
  prepared.workflowPath;
  // @ts-expect-error prepared workflows no longer expose a caller-owned sourceRoot.
  prepared.sourceRoot;

  const removedWorkflow = {
    workspaceDir: "/workspace",
    source: { kind: "path", entry: "workflow.ts" },
    // @ts-expect-error the removed workflow preparation field is not accepted.
    workflow: "workflow.ts",
  } satisfies WorkflowPreparationOptions;
  expectTypeOf(removedWorkflow).not.toEqualTypeOf<WorkflowPreparationOptions>();

  const removedCwd = {
    workspaceDir: "/workspace",
    source: { kind: "path", entry: "workflow.ts" },
    // @ts-expect-error the removed cwd preparation field is not accepted.
    cwd: "/workspace",
  } satisfies WorkflowPreparationOptions;
  expectTypeOf(removedCwd).not.toEqualTypeOf<WorkflowPreparationOptions>();

  const removedSourceRoot = {
    workspaceDir: "/workspace",
    source: { kind: "path", entry: "workflow.ts" },
    // @ts-expect-error the removed sourceRoot preparation field is not accepted.
    sourceRoot: "/snapshot",
  } satisfies WorkflowPreparationOptions;
  expectTypeOf(removedSourceRoot).not.toEqualTypeOf<WorkflowPreparationOptions>();

  // @ts-expect-error catalog provenance is not a compiler source identity.
  const removedCatalog: WorkflowSourceRef = { kind: "global_catalog", name: "catalog", digest: "sha256:test", entry: "workflow.ts" };
  expectTypeOf(removedCatalog).toEqualTypeOf<WorkflowSourceRef>();
});
