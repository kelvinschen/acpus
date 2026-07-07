import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core/ir";
import { checkWorkflow } from "../check/runner.js";
import { compileWorkflow } from "../compiler/worker.js";
import { createScratchDir } from "./temp.js";
import { err, ok, ResultAsync, type Result } from "neverthrow";

export type WorkflowPreparationOptions = {
  workflow: string;
  cwd: string;
};

export type WorkflowPreparationLock = {
  kind: "acpus_workflow_preparation_lock";
  version: 1;
  workflow: {
    entry: string;
    sourceDigest?: string;
  };
  ir: {
    path: "workflow.ir.json";
    digest: string;
  };
  packageLockDigest?: string;
  sourceGraphDigest: string;
  generatedAt: string;
};

export type PreparedWorkflow = {
  workflowPath: string;
  ir: WorkflowIR;
  irJson: string;
  irDigest: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: WorkflowPreparationLock;
};

export type WorkflowPreparationFailure =
  | { type: "check-failed"; phase: "check"; message: string; diagnostics: WorkflowIR["diagnostics"] }
  | { type: "compile-failed"; phase: "compile"; message: string }
  | { type: "validate-failed"; phase: "validate"; message: string; diagnostics: WorkflowIR["diagnostics"]; ir: WorkflowIR };

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
  return ResultAsync.fromPromise(
    prepareWorkflowResult(options, workflowPath),
    cause => ({
      type: "compile-failed",
      phase: "compile",
      message: `Workflow preparation failed: ${causeMessage(cause)}`,
    } satisfies WorkflowPreparationFailure),
  ).andThen(result => result);
}

async function prepareWorkflowResult(options: WorkflowPreparationOptions, workflowPath: string): Promise<Result<PreparedWorkflow, WorkflowPreparationFailure>> {
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

    const compiled = await compileWorkflow(workflowPath, options.cwd, scratchDir);
    if (!compiled.ok) {
      return err({
        type: "compile-failed",
        phase: "compile",
        message: compiled.message,
      });
    }

    if (compiled.ir.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      return err({
        type: "validate-failed",
        phase: "validate",
        message: "Workflow validation failed.",
        diagnostics: compiled.ir.diagnostics,
        ir: compiled.ir,
      });
    }

    const irJson = `${JSON.stringify(compiled.ir, null, 2)}\n`;
    const irDigest = digest(irJson);
    const packageLock = await packageLockDigest(options.cwd);
    const sourceGraphDigest = digest([
      compiled.ir.lock.workflowSourceDigest ?? "",
      packageLock ?? "",
    ].join("\n"));

    return ok({
      workflowPath,
      ir: compiled.ir,
      irJson,
      irDigest,
      sourceGraphDigest,
      ...(packageLock ? { packageLockDigest: packageLock } : {}),
      lock: buildLock(compiled.ir, workflowPath, options.cwd, irDigest, sourceGraphDigest, packageLock),
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function buildLock(ir: WorkflowIR, workflowPath: string, cwd: string, irDigest: string, sourceGraphDigest: string, packageLock: string | undefined): WorkflowPreparationLock {
  return {
    kind: "acpus_workflow_preparation_lock",
    version: 1,
    workflow: {
      entry: relative(cwd, workflowPath),
      ...(ir.lock.workflowSourceDigest ? { sourceDigest: ir.lock.workflowSourceDigest } : {}),
    },
    ir: {
      path: "workflow.ir.json",
      digest: irDigest,
    },
    ...(packageLock ? { packageLockDigest: packageLock } : {}),
    sourceGraphDigest,
    generatedAt: new Date().toISOString(),
  };
}

async function packageLockDigest(cwd: string): Promise<string | undefined> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    try {
      return digest(await readFile(join(cwd, name), "utf8"));
    } catch {
      // Try the next common lockfile name.
    }
  }
  return undefined;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
