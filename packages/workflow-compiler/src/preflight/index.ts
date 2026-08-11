import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { WorkflowCheckResult } from "../check/runner.js";
import { compileWorkflow, type CompileWorkerFailure } from "../compiler/worker.js";
import { sha256Digest, type Sha256Digest } from "../digest.js";
import {
  mergeSourceDiagnostics,
  remapSourceDiagnostics,
  type SourcePreparationFailure,
  type WorkflowSourceBundle,
  type WorkflowSourceInput,
  type WorkflowSourceRef,
} from "./source-model.js";
import {
  prepareWorkflowSource,
  type WorkflowSourcePreparationFailure,
} from "./source-preparation.js";
import { createScratchDir } from "./temp.js";

export type { Sha256Digest } from "../digest.js";
export type {
  WorkflowSourceBundle,
  WorkflowSourceFile,
  WorkflowSourceInput,
  WorkflowSourceRef,
} from "./source-model.js";

export type WorkflowPreparationOptions = {
  workspaceDir: string;
  source: WorkflowSourceInput;
};

export type WorkflowPreparationLock = {
  kind: "acpus_workflow_preparation_lock";
  version: 2;
  workflow: {
    source: WorkflowSourceRef;
    entryDigest: Sha256Digest;
  };
  ir: {
    path: "workflow.ir.json";
    digest: Sha256Digest;
  };
  sourceGraphDigest: Sha256Digest;
  packageLockDigest?: Sha256Digest;
};

type PreparedWorkflowBase = {
  ir: WorkflowIR;
  irJson: string;
  sourceGraphDigest: Sha256Digest;
  packageLockDigest?: Sha256Digest;
  lock: WorkflowPreparationLock;
};

export type PreparedWorkflow =
  | PreparedWorkflowBase & {
      source: Extract<WorkflowSourceRef, { kind: "workspace" }>;
      sourceBundle?: never;
    }
  | PreparedWorkflowBase & {
      source: Extract<WorkflowSourceRef, { kind: "snapshot" }>;
      sourceBundle: WorkflowSourceBundle;
    };

export type WorkflowPreparationFailure =
  | WorkflowSourcePreparationFailure
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

export function tryPrepareWorkflow(
  options: WorkflowPreparationOptions,
): ResultAsync<PreparedWorkflow, WorkflowPreparationFailure> {
  return new ResultAsync(prepareWorkflowResult(options));
}

async function prepareWorkflowResult(
  options: WorkflowPreparationOptions,
): Promise<Result<PreparedWorkflow, WorkflowPreparationFailure>> {
  const input = validatePreparationOptions(options);
  if (input.isErr()) return err(input.error);
  const scratchDir = await createScratchDir();
  try {
    const source = await prepareWorkflowSource({
      workspaceDir: input.value.workspaceDir,
      scratchDir,
      source: input.value.source,
    });
    if (source.isErr()) return err(source.error);
    return await compilePreparedWorkflow({
      workspaceDir: input.value.workspaceDir,
      scratchDir,
      ...source.value,
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}

async function compilePreparedWorkflow(input: {
  workspaceDir: string;
  scratchDir: string;
  check: WorkflowCheckResult;
  entryPath: string;
  sourceRoot: string;
  source: WorkflowSourceRef;
  sourceBundle?: WorkflowSourceBundle;
  sourceGraphDigest: Sha256Digest;
  diagnosticSourceRoot?: string;
  displayEntry?: string;
}): Promise<Result<PreparedWorkflow, WorkflowPreparationFailure>> {
  if (input.check.sourceDigest === undefined) {
    throw new Error("Workflow check succeeded without a source digest.");
  }
  const compiled = await compileWorkflow(input.entryPath, input.sourceRoot, input.scratchDir, {
    dependencyRoot: input.workspaceDir,
    expectedSourceDigest: input.check.sourceDigest,
  });
  if (compiled.isErr()) {
    const failure = remapCompileFailure(compiled.error, {
      scratchDir: input.scratchDir,
      sourceRoot: input.sourceRoot,
      entryPath: input.entryPath,
      displayEntry: input.displayEntry ?? input.entryPath,
      snapshot: input.source.kind === "snapshot",
    });
    return err({
      type: "compile-failed",
      phase: "compile",
      message: failure.message,
      failure,
    });
  }

  const rawCompilerDiagnostics = input.diagnosticSourceRoot
    ? remapSourceDiagnostics(compiled.value.ir.diagnostics, input.diagnosticSourceRoot)
    : compiled.value.ir.diagnostics;
  const compilerDiagnostics = sanitizeDiagnostics(rawCompilerDiagnostics, input.scratchDir);
  const ir: WorkflowIR = {
    ...compiled.value.ir,
    diagnostics: mergeSourceDiagnostics(
      input.check.diagnostics.filter(diagnostic => diagnostic.severity === "warning"),
      compilerDiagnostics,
    ),
  };
  if (input.source.kind === "snapshot" && containsPrivateMaterializationPath(ir, input.scratchDir)) {
    return err({
      type: "source-invalid",
      phase: "source",
      message: "Snapshot workflow IR must not reference the compiler's private source materialization.",
    });
  }
  if (ir.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    return err({
      type: "validate-failed",
      phase: "validate",
      message: "Workflow validation failed.",
      diagnostics: ir.diagnostics,
      ir,
    });
  }

  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  const irFileDigest = sha256Digest(irJson);
  const packageLockResult = await tryReadPackageLockDigest(input.workspaceDir);
  if (packageLockResult.isErr()) return err({ ...packageLockResult.error, phase: "lock" });
  const packageLockDigest = packageLockResult.value;
  const lock = buildLock(
    input.source,
    compiled.value.sourceDigest,
    irFileDigest,
    input.sourceGraphDigest,
    packageLockDigest,
  );
  const base: PreparedWorkflowBase = {
    ir,
    irJson,
    sourceGraphDigest: input.sourceGraphDigest,
    ...(packageLockDigest ? { packageLockDigest } : {}),
    lock,
  };
  if (input.source.kind === "snapshot") {
    if (!input.sourceBundle) throw new Error("Snapshot preparation succeeded without a source bundle.");
    return ok({ ...base, source: input.source, sourceBundle: input.sourceBundle });
  }
  return ok({ ...base, source: input.source });
}

function validatePreparationOptions(
  options: WorkflowPreparationOptions,
): Result<WorkflowPreparationOptions, SourcePreparationFailure> {
  if (!options || typeof options !== "object" || typeof options.workspaceDir !== "string") {
    return err({ type: "source-invalid", phase: "source", message: "Workflow workspaceDir must be a string." });
  }
  const source = options.source;
  if (!source || typeof source !== "object" || (source.kind !== "path" && source.kind !== "files")) {
    return err({ type: "source-invalid", phase: "source", message: "Workflow source must be a path or files input." });
  }
  if (source.kind === "path" && typeof source.entry !== "string") {
    return err({ type: "source-invalid", phase: "source", message: "Workflow path entry must be a string." });
  }
  return ok({ workspaceDir: resolve(options.workspaceDir), source });
}

function buildLock(
  source: WorkflowSourceRef,
  entryDigest: Sha256Digest,
  irFileDigest: Sha256Digest,
  graphDigest: Sha256Digest,
  packageLockDigest: Sha256Digest | undefined,
): WorkflowPreparationLock {
  return {
    kind: "acpus_workflow_preparation_lock",
    version: 2,
    workflow: {
      source,
      entryDigest,
    },
    ir: {
      path: "workflow.ir.json",
      digest: irFileDigest,
    },
    sourceGraphDigest: graphDigest,
    ...(packageLockDigest ? { packageLockDigest } : {}),
  };
}

function remapCompileFailure(
  failure: CompileWorkerFailure,
  options: {
    scratchDir: string;
    sourceRoot: string;
    entryPath: string;
    displayEntry: string;
    snapshot: boolean;
  },
): CompileWorkerFailure {
  return replaceStrings(failure, value => {
    let sanitized = replacePathReferences(value, options.entryPath, options.displayEntry);
    if (options.snapshot) {
      sanitized = replacePathReferences(sanitized, options.sourceRoot, "<workflow-source>");
    }
    return replacePathReferences(sanitized, options.scratchDir, "<workflow-scratch>");
  }) as CompileWorkerFailure;
}

function sanitizeDiagnostics(
  diagnostics: readonly DiagnosticIR[],
  scratchDir: string,
): DiagnosticIR[] {
  return replaceStrings(
    diagnostics,
    value => replacePathReferences(value, scratchDir, "<workflow-scratch>"),
  ) as DiagnosticIR[];
}

function replaceStrings(value: unknown, replace: (value: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, replace));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replace)]));
}

function containsPrivateMaterializationPath(value: unknown, scratchDir: string): boolean {
  const references = pathReferences(scratchDir);
  const contains = (candidate: unknown): boolean => {
    if (typeof candidate === "string") return references.some(reference => candidate.includes(reference));
    if (Array.isArray(candidate)) return candidate.some(contains);
    if (!candidate || typeof candidate !== "object") return false;
    return Object.values(candidate).some(contains);
  };
  return contains(value);
}

function replacePathReferences(value: string, path: string, replacement: string): string {
  return pathReferences(path).reduce(
    (current, reference) => current.replaceAll(reference, replacement),
    value,
  );
}

function pathReferences(path: string): [string, string] {
  const absolute = resolve(path);
  return [pathToFileURL(absolute).href, absolute];
}

export function tryReadPackageLockDigest(
  workspaceDir: string,
): ResultAsync<Sha256Digest | undefined, PackageLockFailure> {
  return new ResultAsync(readPackageLockDigest(workspaceDir));
}

async function readPackageLockDigest(
  workspaceDir: string,
): Promise<Result<Sha256Digest | undefined, PackageLockFailure>> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(workspaceDir, name);
    try {
      return ok(sha256Digest(await readFile(path, "utf8")));
    } catch (cause) {
      if (isMissingPathError(cause)) continue;
      return err({
        type: "package-lock-read-failed",
        path,
        message: `Package lock '${path}' could not be read: ${causeMessage(cause)}`,
      });
    }
  }
  return ok(undefined);
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPathError(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
