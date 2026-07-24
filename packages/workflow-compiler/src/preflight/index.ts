import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core/ir";
import { checkWorkflow } from "../check/runner.js";
import { compileWorkflow, type CompileWorkerFailure } from "../compiler/worker.js";
import { createScratchDir } from "./temp.js";
import { err, ok, ResultAsync, type Result } from "neverthrow";

export type WorkflowPreparationOptions = {
  workflow: string;
  cwd: string;
  source?: WorkflowSourceRef;
  sourceRoot?: string;
};

export type WorkflowSourceRef =
  | { kind: "workspace"; entry: string }
  | { kind: "global_catalog"; name: string; digest: string; entry: string };

export type WorkflowPreparationLock = {
  kind: "acpus_workflow_preparation_lock";
  version: 1;
  workflow: {
    source: WorkflowSourceRef;
    sourceDigest: string;
  };
  ir: {
    path: "workflow.ir.json";
    digest: string;
  };
  packageLockDigest?: string;
  sourceGraphDigest: string;
};

export type PreparedWorkflow = {
  workflowPath: string;
  source: WorkflowSourceRef;
  sourceRoot?: string;
  ir: WorkflowIR;
  irJson: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: WorkflowPreparationLock;
};

export type WorkflowPreparationFailure =
  | { type: "check-failed"; phase: "check"; message: string; diagnostics: WorkflowIR["diagnostics"] }
  | { type: "compile-failed"; phase: "compile"; message: string; failure: CompileWorkerFailure }
  | (PackageLockFailure & { phase: "lock" })
  | { type: "validate-failed"; phase: "validate"; message: string; diagnostics: WorkflowIR["diagnostics"]; ir: WorkflowIR };

export type PackageLockFailure = {
  type: "package-lock-read-failed";
  path: string;
  message: string;
};

export class WorkflowPreparationError extends Error {
  constructor(readonly failure: WorkflowPreparationFailure) {
    super(failure.message);
  }
}

export async function prepareWorkflow(options: WorkflowPreparationOptions): Promise<PreparedWorkflow> {
  const result = await tryPrepareWorkflow(options);
  return result.match(
    prepared => prepared,
    failure => {
      throw new WorkflowPreparationError(failure);
    },
  );
}

export function tryPrepareWorkflow(options: WorkflowPreparationOptions): ResultAsync<PreparedWorkflow, WorkflowPreparationFailure> {
  const workflowPath = resolve(options.cwd, options.workflow);
  const sourceRoot = resolve(options.sourceRoot ?? options.cwd);
  const source = options.source ?? {
    kind: "workspace",
    entry: toPortablePath(relative(sourceRoot, workflowPath)),
  };
  return new ResultAsync(prepareWorkflowResult(options, workflowPath, sourceRoot, source));
}

async function prepareWorkflowResult(
  options: WorkflowPreparationOptions,
  workflowPath: string,
  sourceRoot: string,
  source: WorkflowSourceRef,
): Promise<Result<PreparedWorkflow, WorkflowPreparationFailure>> {
  const scratchDir = await createScratchDir();
  try {
    const check = await checkWorkflow(workflowPath, options.cwd, scratchDir);
    if (check.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      return err({
        type: "check-failed",
        phase: "check",
        message: "Workflow check failed.",
        diagnostics: check.diagnostics,
      });
    }

    const compiled = await compileWorkflow(workflowPath, sourceRoot, scratchDir, options.cwd);
    if (compiled.isErr()) {
      return err({
        type: "compile-failed",
        phase: "compile",
        message: compiled.error.message,
        failure: compiled.error,
      });
    }

    if (compiled.value.ir.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      return err({
        type: "validate-failed",
        phase: "validate",
        message: "Workflow validation failed.",
        diagnostics: compiled.value.ir.diagnostics,
        ir: compiled.value.ir,
      });
    }

    const irJson = `${JSON.stringify(compiled.value.ir, null, 2)}\n`;
    const irFileDigest = digest(irJson);
    const packageLockResult = await tryReadPackageLockDigest(options.cwd);
    if (packageLockResult.isErr()) return err({ ...packageLockResult.error, phase: "lock" });
    const packageLock = packageLockResult.value;
    const sourceGraphDigest = digest([
      compiled.value.sourceDigest,
      packageLock ?? "",
    ].join("\n"));

    return ok({
      workflowPath,
      source,
      ...(source.kind === "global_catalog" ? { sourceRoot } : {}),
      ir: compiled.value.ir,
      irJson,
      sourceGraphDigest,
      ...(packageLock ? { packageLockDigest: packageLock } : {}),
      lock: buildLock(source, compiled.value.sourceDigest, irFileDigest, sourceGraphDigest, packageLock),
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function buildLock(source: WorkflowSourceRef, sourceDigest: string, irFileDigest: string, sourceGraphDigest: string, packageLock: string | undefined): WorkflowPreparationLock {
  return {
    kind: "acpus_workflow_preparation_lock",
    version: 1,
    workflow: {
      source,
      sourceDigest,
    },
    ir: {
      path: "workflow.ir.json",
      digest: irFileDigest,
    },
    ...(packageLock ? { packageLockDigest: packageLock } : {}),
    sourceGraphDigest,
  };
}

function toPortablePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

export function tryReadPackageLockDigest(cwd: string): ResultAsync<string | undefined, PackageLockFailure> {
  return new ResultAsync(readPackageLockDigest(cwd));
}

async function readPackageLockDigest(cwd: string): Promise<Result<string | undefined, PackageLockFailure>> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(cwd, name);
    try {
      return ok(digest(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissingPathError(error)) continue;
      return err({
        type: "package-lock-read-failed",
        path,
        message: `Package lock '${path}' could not be read: ${causeMessage(error)}`,
      });
    }
  }
  return ok(undefined);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPathError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
