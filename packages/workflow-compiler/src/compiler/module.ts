import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflowDefinition, isWorkflowDefinition } from "@acpus/core/workflow";
import { validateWorkflowIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { analyzeWorkflowTasks, resolveTaskReferenceMetadata, type TaskReferenceMetadata } from "../task-analysis/index.js";
import { err, ok, Result, ResultAsync, type Result as NeverthrowResult } from "neverthrow";
import { registerOfficialAuthoringImports } from "../official-imports.js";

export type CompileOptions = {
  sourcePath?: string;
  cwd?: string;
};

export type CompileWorkflowModuleError =
  | { type: "workflow-source-read-failed"; entry: string; message: string }
  | { type: "module-import-failed"; entry: string; message: string }
  | { type: "invalid-default-export"; entry: string; message: string }
  | { type: "workflow-build-failed"; entry: string; message: string }
  | { type: "task-analysis-failed"; entry: string; message: string }
  | { type: "workflow-outside-workspace"; workflowFile: string; cwd: string; message: string };

export async function compileWorkflowModule(entry: string, options: CompileOptions = {}): Promise<WorkflowIR> {
  const result = await tryCompileWorkflowModule(entry, options);
  return result.match(
    ir => ir,
    error => {
      throw new Error(error.message);
    },
  );
}

export function tryCompileWorkflowModule(entry: string, options: CompileOptions = {}): ResultAsync<WorkflowIR, CompileWorkflowModuleError> {
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
      importWorkflowModule(absolute),
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
      const built = Result.fromThrowable(() => {
        const ir = compileWorkflowDefinition(def, { source: options.sourcePath ?? entry, validate: false });
        ir.lock.workflowSourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
        return ir;
      }, cause => ({
        type: "workflow-build-failed",
        entry,
        message: `Workflow '${entry}' could not be lowered: ${causeMessage(cause)}`,
      } satisfies CompileWorkflowModuleError))();
      if (built.isErr()) return err(built.error);
      const ir = built.value;
      return ResultAsync.fromPromise(
        analyzeWorkflowTasks(absolute, source),
        cause => ({
          type: "task-analysis-failed",
          entry,
          message: `Workflow task analysis failed for '${entry}': ${causeMessage(cause)}`,
        } satisfies CompileWorkflowModuleError),
      ).andThen(analysis => {
        const referrerPath = toContainedWorkspacePath(options.cwd ?? process.cwd(), absolute);
        if (referrerPath.isErr()) return err(referrerPath.error);
        applyTaskReferenceMetadata(ir, resolveTaskReferenceMetadata(analysis), referrerPath.value);
        ir.diagnostics.push(...validateWorkflowIR(ir));
        return ok(ir);
      });
    }),
  );
}

function importWorkflowModule(absolute: string): Promise<Record<string, unknown>> {
  registerOfficialAuthoringImports();
  return import(pathToFileURL(absolute).href) as Promise<Record<string, unknown>>;
}

function applyTaskReferenceMetadata(ir: WorkflowIR, metadata: Map<string, TaskReferenceMetadata>, referrerPath: string): void {
  for (const node of taskNodes(ir.root)) {
    if (node.run.target.kind !== "module") continue;
    const task = metadata.get(node.id);
    if (!task?.specifier || !task.exportName) continue;
    node.run.target = {
      kind: "module",
      runtime: "node",
      specifier: task.specifier,
      exportName: task.exportName,
      referrer: { kind: "workflow", path: referrerPath },
    };
  }
}

function* taskNodes(scope: ScopeIR): Generator<Extract<ScopeIR["nodes"][number], { kind: "task" }>> {
  for (const node of scope.nodes) {
    if (node.kind === "task") yield node;
    if (node.kind === "if") {
      yield* taskNodes(node.then);
      if (node.else) yield* taskNodes(node.else);
    } else if (node.kind === "switch") {
      for (const item of node.cases) yield* taskNodes(item.then);
      if (node.default) yield* taskNodes(node.default);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) yield* taskNodes(branch.scope);
    } else if (node.kind === "fanout" || node.kind === "loop") {
      yield* taskNodes(node.do);
    }
  }
}

function toContainedWorkspacePath(cwd: string, workflowFile: string): NeverthrowResult<string, CompileWorkflowModuleError> {
  const path = relative(cwd, workflowFile);
  if (path.startsWith("..") || path === "" || path.split(/[\\/]/).includes("..")) {
    return err({
      type: "workflow-outside-workspace",
      workflowFile,
      cwd,
      message: `Workflow file '${workflowFile}' must be inside workspace '${cwd}'.`,
    });
  }
  return ok(toWorkspacePath(path));
}

function toWorkspacePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
