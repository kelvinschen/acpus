import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import { importAuthoringModule } from "@acpus/loader";
import {
  isWorkflowDefinition,
  tryCompileWorkflowDefinition,
  type ReusableTaskLinkPlan,
} from "@acpus/core/workflow";
import type { WorkflowIR } from "@acpus/core/ir";
import { analyzeWorkflowTasks, resolveTaskReferenceMetadata } from "../task-analysis/index.js";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export type CompiledWorkflowModule = {
  ir: WorkflowIR;
  sourceDigest: Sha256Digest;
};

export type CompileWorkflowModuleError =
  | { type: "workflow-source-read-failed"; entry: string; message: string }
  | { type: "workflow-source-changed"; entry: string; message: string }
  | { type: "module-import-failed"; entry: string; message: string }
  | { type: "invalid-default-export"; entry: string; message: string }
  | { type: "workflow-build-failed"; entry: string; message: string }
  | { type: "task-analysis-failed"; entry: string; message: string }
  | { type: "workflow-outside-workspace"; workflowFile: string; cwd: string; message: string };

export type CompileWorkflowModuleOptions = {
  dependencyRoot?: string;
  expectedSourceDigest: Sha256Digest;
};

export function tryCompileWorkflowModule(
  entry: string,
  sourceRoot: string,
  options: CompileWorkflowModuleOptions,
): Effect.Effect<CompiledWorkflowModule, CompileWorkflowModuleError> {
  return Effect.promise(() => compileWorkflowModuleResult(entry, sourceRoot, options)).pipe(
    Effect.flatMap(Effect.fromResult),
  );
}

async function compileWorkflowModuleResult(
  entry: string,
  sourceRoot: string,
  options: CompileWorkflowModuleOptions,
): Promise<Result.Result<CompiledWorkflowModule, CompileWorkflowModuleError>> {
  const absolute = resolve(entry);
  const dependencyRoot = options.dependencyRoot ?? sourceRoot;
  const source = await readWorkflowSourceResult(absolute, entry);
  if (Result.isFailure(source)) return Result.fail(source.failure);
  if (sha256Digest(source.success) !== options.expectedSourceDigest) return Result.fail(sourceChanged(entry));
  const referrerPath = toContainedSourcePath(sourceRoot, absolute);
  if (Result.isFailure(referrerPath)) return Result.fail(referrerPath.failure);

  let mod: Record<string, unknown>;
  try {
    mod = await importWorkflowModule(absolute, sourceRoot, dependencyRoot);
  } catch (cause) {
    return Result.fail({
        type: "module-import-failed",
        entry,
        message: `Workflow module '${entry}' could not be imported: ${causeMessage(cause)}`,
      });
  }
  const def = mod.default;
  if (!isWorkflowDefinition(def)) {
    return Result.fail({
      type: "invalid-default-export",
      entry,
      message: `Default export of ${entry} is not an Acpus workflow definition.`,
    });
  }

  let analysis: Awaited<ReturnType<typeof analyzeWorkflowTasks>>;
  try {
    analysis = await analyzeWorkflowTasks(absolute, source.success);
  } catch (cause) {
    return Result.fail({
      type: "task-analysis-failed",
      entry,
      message: `Workflow task analysis failed for '${entry}': ${causeMessage(cause)}`,
    });
  }
  if (Result.isFailure(analysis)) {
    return Result.fail({
      type: "task-analysis-failed",
      entry,
      message: `Workflow task analysis failed for '${entry}': ${analysis.failure.message}`,
    });
  }
  const reusableTasks: ReusableTaskLinkPlan = {
    referrerPath: referrerPath.success,
    targets: resolveTaskReferenceMetadata(analysis.success),
  };
  const built = tryCompileWorkflowDefinition(def, { reusableTasks });
  if (built._tag === "Failure") {
    return Result.fail({
      type: "workflow-build-failed",
      entry,
      message: `Workflow '${entry}' could not be lowered: ${built.failure.message}`,
    });
  }
  const currentSource = await readWorkflowSourceResult(absolute, entry);
  if (Result.isFailure(currentSource)) return Result.fail(currentSource.failure);
  if (sha256Digest(currentSource.success) !== options.expectedSourceDigest) return Result.fail(sourceChanged(entry));
  return Result.succeed({
    ir: built.success,
    sourceDigest: options.expectedSourceDigest,
  });
}

async function readWorkflowSourceResult(
  absolute: string,
  entry: string,
): Promise<Result.Result<string, CompileWorkflowModuleError>> {
  try {
    return Result.succeed(await readFile(absolute, "utf8"));
  } catch (cause) {
    return Result.fail({
      type: "workflow-source-read-failed",
      entry,
      message: `Workflow source '${entry}' could not be read: ${causeMessage(cause)}`,
    });
  }
}

function sourceChanged(entry: string): CompileWorkflowModuleError {
  return {
    type: "workflow-source-changed",
    entry,
    message: `Workflow source '${entry}' changed after the check phase; prepare it again.`,
  };
}

function importWorkflowModule(
  absolute: string,
  sourceRoot: string,
  dependencyRoot: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(absolute).href;
  return importAuthoringModule(url, { parentURL: url, sourceRoot, dependencyRoot });
}

function toContainedSourcePath(sourceRoot: string, workflowFile: string): Result.Result<string, CompileWorkflowModuleError> {
  let path: string;
  try {
    path = relative(realpathSync(sourceRoot), realpathSync(workflowFile));
  } catch {
    return Result.fail(outsideSourceRoot(workflowFile, sourceRoot));
  }
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return Result.fail(outsideSourceRoot(workflowFile, sourceRoot));
  }
  return Result.succeed(toWorkspacePath(path));
}

function outsideSourceRoot(workflowFile: string, sourceRoot: string): CompileWorkflowModuleError {
  return {
    type: "workflow-outside-workspace",
    workflowFile,
    cwd: sourceRoot,
    message: `Workflow file '${workflowFile}' must be inside source root '${sourceRoot}'.`,
  };
}

function toWorkspacePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
