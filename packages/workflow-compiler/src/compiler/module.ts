import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { importAuthoringModule } from "@acpus/loader";
import {
  isWorkflowDefinition,
  tryCompileWorkflowDefinition,
  type ReusableTaskLinkPlan,
} from "@acpus/core/workflow";
import type { WorkflowIR } from "@acpus/core/ir";
import { analyzeWorkflowTasks, resolveTaskReferenceMetadata } from "../task-analysis/index.js";
import { err, ok, ResultAsync, type Result as NeverthrowResult } from "neverthrow";

export type CompiledWorkflowModule = {
  ir: WorkflowIR;
  sourceDigest: string;
};

export type CompileWorkflowModuleError =
  | { type: "workflow-source-read-failed"; entry: string; message: string }
  | { type: "module-import-failed"; entry: string; message: string }
  | { type: "invalid-default-export"; entry: string; message: string }
  | { type: "workflow-build-failed"; entry: string; message: string }
  | { type: "task-analysis-failed"; entry: string; message: string }
  | { type: "workflow-outside-workspace"; workflowFile: string; cwd: string; message: string };

export function tryCompileWorkflowModule(
  entry: string,
  sourceRoot: string,
  dependencyRoot = sourceRoot,
): ResultAsync<CompiledWorkflowModule, CompileWorkflowModuleError> {
  const absolute = resolve(entry);
  return ResultAsync.fromPromise(
    readFile(absolute, "utf8"),
    cause => ({
      type: "workflow-source-read-failed",
      entry,
      message: `Workflow source '${entry}' could not be read: ${causeMessage(cause)}`,
    } satisfies CompileWorkflowModuleError),
  ).andThen(source =>
    ResultAsync.fromPromise(
      importWorkflowModule(absolute, sourceRoot, dependencyRoot),
      cause => ({
        type: "module-import-failed",
        entry,
        message: `Workflow module '${entry}' could not be imported: ${causeMessage(cause)}`,
      } satisfies CompileWorkflowModuleError),
    ).andThen(mod => {
      const def = mod.default;
      if (!isWorkflowDefinition(def)) {
        return err({
          type: "invalid-default-export",
          entry,
          message: `Default export of ${entry} is not an Acpus workflow definition.`,
        } satisfies CompileWorkflowModuleError);
      }
      return ResultAsync.fromPromise(
        analyzeWorkflowTasks(absolute, source),
        cause => ({
          type: "task-analysis-failed",
          entry,
          message: `Workflow task analysis failed for '${entry}': ${causeMessage(cause)}`,
        } satisfies CompileWorkflowModuleError),
      ).andThen(result => result.mapErr(failure => ({
        type: "task-analysis-failed",
        entry,
        message: `Workflow task analysis failed for '${entry}': ${failure.message}`,
      } satisfies CompileWorkflowModuleError))).andThen(analysis => {
        const referrerPath = toContainedSourcePath(sourceRoot, absolute);
        if (referrerPath.isErr()) return err(referrerPath.error);
        const reusableTasks: ReusableTaskLinkPlan = {
          referrerPath: referrerPath.value,
          targets: resolveTaskReferenceMetadata(analysis),
        };
        const built = tryCompileWorkflowDefinition(def, { reusableTasks });
        if (built.isErr()) {
          return err({
            type: "workflow-build-failed",
            entry,
            message: `Workflow '${entry}' could not be lowered: ${built.error.message}`,
          } satisfies CompileWorkflowModuleError);
        }
        return ok({
          ir: built.value,
          sourceDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
        });
      });
    }),
  );
}

function importWorkflowModule(
  absolute: string,
  sourceRoot: string,
  dependencyRoot: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(absolute).href;
  return importAuthoringModule(url, { parentURL: url, sourceRoot, dependencyRoot });
}

function toContainedSourcePath(sourceRoot: string, workflowFile: string): NeverthrowResult<string, CompileWorkflowModuleError> {
  let path: string;
  try {
    path = relative(realpathSync(sourceRoot), realpathSync(workflowFile));
  } catch {
    return err(outsideSourceRoot(workflowFile, sourceRoot));
  }
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return err(outsideSourceRoot(workflowFile, sourceRoot));
  }
  return ok(toWorkspacePath(path));
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
