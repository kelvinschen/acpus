import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { WorkflowCheckResult } from "../check/runner.js";
import { compileWorkflow, type CompileWorkerFailure } from "../compiler/worker.js";
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
  const result = await Effect.runPromise(Effect.result(tryPrepareWorkflow(options)));
  return Result.match(result, {
    onSuccess: prepared => prepared,
    onFailure: failure => { throw new WorkflowPreparationError(failure); },
  });
}

export function tryPrepareWorkflow(
  options: WorkflowPreparationOptions,
): Effect.Effect<PreparedWorkflow, WorkflowPreparationFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const input = yield* Effect.fromResult(validatePreparationOptions(options));
    const scratchDir = yield* Effect.acquireRelease(
      Effect.promise(createScratchDir),
      path => Effect.promise(() => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })),
    );
    const source = yield* Effect.promise(() => prepareWorkflowSource({
      workspaceDir: input.workspaceDir,
      scratchDir,
      source: input.source,
    })).pipe(Effect.flatMap(Effect.fromResult));
    return yield* compilePreparedWorkflow({
      workspaceDir: input.workspaceDir,
      scratchDir,
      ...source,
    });
  }));
}

function compilePreparedWorkflow(input: {
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
}): Effect.Effect<PreparedWorkflow, WorkflowPreparationFailure> {
  return Effect.gen(function* () {
    if (input.check.sourceDigest === undefined) {
      return yield* Effect.die(new Error("Workflow check succeeded without a source digest."));
    }
    const compiled = yield* compileWorkflow(input.entryPath, input.sourceRoot, input.scratchDir, {
      dependencyRoot: input.workspaceDir,
      expectedSourceDigest: input.check.sourceDigest,
    }).pipe(Effect.mapError(rawFailure => {
      const failure = remapCompileFailure(rawFailure, {
        scratchDir: input.scratchDir,
        sourceRoot: input.sourceRoot,
        entryPath: input.entryPath,
        displayEntry: input.displayEntry ?? input.entryPath,
        snapshot: input.source.kind === "snapshot",
      });
      return {
        type: "compile-failed" as const,
        phase: "compile" as const,
        message: failure.message,
        failure,
      };
    }));

    const rawCompilerDiagnostics = input.diagnosticSourceRoot
      ? remapSourceDiagnostics(compiled.ir.diagnostics, input.diagnosticSourceRoot)
      : compiled.ir.diagnostics;
    const compilerDiagnostics = sanitizeDiagnostics(rawCompilerDiagnostics, input.scratchDir);
    const ir: WorkflowIR = {
      ...compiled.ir,
      diagnostics: mergeSourceDiagnostics(
        input.check.diagnostics.filter(diagnostic => diagnostic.severity === "warning"),
        compilerDiagnostics,
      ),
    };
    if (input.source.kind === "snapshot" && containsPrivateMaterializationPath(ir, input.scratchDir)) {
      return yield* Effect.fail({
        type: "source-invalid" as const,
        phase: "source" as const,
        message: "Snapshot workflow IR must not reference the compiler's private source materialization.",
      });
    }
    if (ir.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      return yield* Effect.fail({
        type: "validate-failed" as const,
        phase: "validate" as const,
        message: "Workflow validation failed.",
        diagnostics: ir.diagnostics,
        ir,
      });
    }

    const irJson = `${JSON.stringify(ir, null, 2)}\n`;
    const irFileDigest = sha256Digest(irJson);
    const packageLockDigest = yield* tryReadPackageLockDigest(input.workspaceDir).pipe(
      Effect.mapError(failure => ({ ...failure, phase: "lock" as const })),
    );
    const lock = buildLock(
      input.source,
      compiled.sourceDigest,
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
      if (!input.sourceBundle) {
        return yield* Effect.die(new Error("Snapshot preparation succeeded without a source bundle."));
      }
      return { ...base, source: input.source, sourceBundle: input.sourceBundle };
    }
    return { ...base, source: input.source };
  });
}

function validatePreparationOptions(
  options: WorkflowPreparationOptions,
): Result.Result<WorkflowPreparationOptions, SourcePreparationFailure> {
  if (!options || typeof options !== "object" || typeof options.workspaceDir !== "string") {
    return Result.fail({ type: "source-invalid", phase: "source", message: "Workflow workspaceDir must be a string." });
  }
  const source = options.source;
  if (!source || typeof source !== "object" || (source.kind !== "path" && source.kind !== "files")) {
    return Result.fail({ type: "source-invalid", phase: "source", message: "Workflow source must be a path or files input." });
  }
  if (source.kind === "path" && typeof source.entry !== "string") {
    return Result.fail({ type: "source-invalid", phase: "source", message: "Workflow path entry must be a string." });
  }
  return Result.succeed({ workspaceDir: resolve(options.workspaceDir), source });
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
): Effect.Effect<Sha256Digest | undefined, PackageLockFailure> {
  return Effect.promise(() => readPackageLockDigest(workspaceDir)).pipe(Effect.flatMap(Effect.fromResult));
}

async function readPackageLockDigest(
  workspaceDir: string,
): Promise<Result.Result<Sha256Digest | undefined, PackageLockFailure>> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(workspaceDir, name);
    try {
      return Result.succeed(sha256Digest(await readFile(path, "utf8")));
    } catch (cause) {
      if (isMissingPathError(cause)) continue;
      return Result.fail({
        type: "package-lock-read-failed",
        path,
        message: `Package lock '${path}' could not be read: ${causeMessage(cause)}`,
      });
    }
  }
  return Result.succeed(undefined);
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPathError(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
