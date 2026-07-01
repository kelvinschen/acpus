import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflowDefinition, isWorkflowDefinition } from "@acpus/core/workflow";
import { validateWorkflowIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { analyzeWorkflowTasks, resolveTaskReferenceMetadata, type TaskReferenceMetadata } from "../task-analysis/index.js";

export type CompileOptions = {
  sourcePath?: string;
  cwd?: string;
};

export async function compileWorkflowModule(entry: string, options: CompileOptions = {}): Promise<WorkflowIR> {
  const absolute = resolve(entry);
  const source = await readFile(absolute, "utf8");
  const mod = await import(pathToFileURL(absolute).href);
  const def = mod.default;
  if (!isWorkflowDefinition(def)) throw new Error(`Default export of ${entry} is not an Acpus workflow definition.`);
  const ir = compileWorkflowDefinition(def, { source: options.sourcePath ?? entry, validate: false });
  ir.lock.workflowSourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const analysis = await analyzeWorkflowTasks(absolute, source);
  applyTaskReferenceMetadata(ir, resolveTaskReferenceMetadata(analysis), options.cwd ?? process.cwd(), absolute);
  ir.diagnostics.push(...validateWorkflowIR(ir));
  return ir;
}

function applyTaskReferenceMetadata(ir: WorkflowIR, metadata: Map<string, TaskReferenceMetadata>, cwd: string, workflowFile: string): void {
  const referrerPath = toContainedWorkspacePath(cwd, workflowFile);
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

function toContainedWorkspacePath(cwd: string, workflowFile: string): string {
  const path = relative(cwd, workflowFile);
  if (path.startsWith("..") || path === "" || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Workflow file '${workflowFile}' must be inside workspace '${cwd}'.`);
  }
  return toWorkspacePath(path);
}

function toWorkspacePath(path: string): string {
  return path.split(/[\\/]/).join("/");
}
