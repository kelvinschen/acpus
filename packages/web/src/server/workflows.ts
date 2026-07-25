import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { walkNodes } from "@acpus/core/ir";
import { staticExprShape } from "@acpus/expression/ir";
import { tryPrepareWorkflow, type PreparedWorkflow } from "@acpus/workflow-compiler";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { WorkflowVisualizationResult, WorkflowVisualizationSource } from "../api-types.js";
import { workflowIrToWebGraph, type WebGraph } from "./graph.js";
import { staticVizCss, staticVizJs } from "./static-viz-assets.generated.js";
export type { WorkflowVisualizationResult, WorkflowVisualizationSource } from "../api-types.js";

export type ProjectWorkflowCatalogEntry = {
  name: string;
  entryPath: string;
};

export type WorkflowFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "workflow";
};

export type WorkflowBrowseFailure = {
  type: "workflow-browse-invalid";
  reason: "outside-workspace" | "not-found" | "not-directory";
  message: string;
};

export async function listProjectWorkflowCatalog(cwd: string): Promise<ProjectWorkflowCatalogEntry[]> {
  const root = join(cwd, ".acpus", "workflows");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const realWorkspace = await realpath(resolve(cwd));
  const realRoot = await realpath(root);
  if (!isContainedPath(realWorkspace, realRoot)) throw new Error("Project workflow catalog resolves outside the workspace.");
  const catalog = await Promise.all(entries.map(async name => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
    const packagePath = join(root, name);
    const entryPath = join(packagePath, "workflow.ts");
    if (!await isContainedFile(entryPath, realRoot)) return undefined;
    return { name, entryPath };
  }));
  return catalog.flatMap(entry => entry ? [entry] : []).sort((left, right) => left.name.localeCompare(right.name));
}

export function listWorkflowFiles(cwd: string, dir = ""): ResultAsync<{ dir: string; entries: WorkflowFileEntry[] }, WorkflowBrowseFailure> {
  return new ResultAsync(listWorkflowFilesResult(cwd, dir));
}

async function listWorkflowFilesResult(cwd: string, dir: string): Promise<Result<{ dir: string; entries: WorkflowFileEntry[] }, WorkflowBrowseFailure>> {
  const base = resolve(cwd);
  const current = resolveWorkspacePath(base, dir);
  if (!current) return err(workflowBrowseFailure("outside-workspace", "Path escapes workspace."));
  let currentStat;
  try {
    currentStat = await stat(current);
  } catch (error) {
    if (isMissingPathError(error)) return err(workflowBrowseFailure("not-found", "Path does not exist."));
    throw error;
  }
  if (!currentStat.isDirectory()) return err(workflowBrowseFailure("not-directory", "Path is not a directory."));
  const [realBase, realCurrent] = await Promise.all([realpath(base), realpath(current)]);
  if (!isContainedPath(realBase, realCurrent)) {
    return err(workflowBrowseFailure("outside-workspace", "Path escapes workspace."));
  }

  const entries = await Promise.all((await readdir(current, { withFileTypes: true }))
    .filter(entry => !skipEntry(entry.name))
    .map(async entry => {
      const absolute = join(current, entry.name);
      const rel = relative(base, absolute);
      if (entry.isDirectory()) return { name: entry.name, path: rel, kind: "directory" as const };
      return entry.isFile() && isWorkflowFile(entry.name)
        ? { name: entry.name, path: rel, kind: "workflow" as const }
        : undefined;
    }));
  return ok({
    dir: relative(base, current),
    entries: entries.flatMap(entry => entry ? [entry] : []).sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    ),
  });
}

export async function visualizeWorkflowSource(cwd: string, source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  const workflow = source.kind === "catalog"
    ? (await catalogWorkflowPath(cwd, source.name))
    : await workspaceWorkflowPath(cwd, source.path);
  if (!workflow) {
    return { status: "failed", phase: "compile", message: "Workflow source was not found." };
  }

  const prepared = await tryPrepareWorkflow({ cwd, workflow });
  return prepared.match(
    workflowVisualizationFromPrepared,
    failure => ({ status: "failed", phase: failure.phase, message: failure.message }),
  );
}

export function workflowVisualizationFromPrepared(prepared: PreparedWorkflow): Extract<WorkflowVisualizationResult, { status: "ready" }> {
  return {
    status: "ready",
    graph: workflowIrToWebGraph(prepared.ir),
    workflow: {
      name: prepared.ir.name,
      ...(prepared.ir.description === undefined ? {} : { description: prepared.ir.description }),
      irVersion: prepared.ir.irVersion,
      nodeCount: Array.from(walkNodes(prepared.ir.root)).length,
    },
    contract: {
      ...(prepared.ir.inputSchema === undefined ? {} : { inputSchema: prepared.ir.inputSchema }),
      output: prepared.ir.root.output,
      outputShape: staticExprShape(prepared.ir.root.output),
    },
    sourceGraphDigest: prepared.sourceGraphDigest,
  };
}

export type WorkflowVizHtmlOptions = {
  graph: WebGraph;
  workflow: Extract<WorkflowVisualizationResult, { status: "ready" }>["workflow"];
  contract: Extract<WorkflowVisualizationResult, { status: "ready" }>["contract"];
  sourceGraphDigest: string;
};

export function renderWorkflowVizHtml(options: WorkflowVizHtmlOptions): string {
  const bundle = {
    graph: options.graph,
    workflow: options.workflow,
    contract: options.contract,
    sourceGraphDigest: options.sourceGraphDigest,
  };
  const bundleJson = JSON.stringify(bundle).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.workflow.name)}</title>
<style>
${staticVizCss}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__ACPUS_WORKFLOW_VIZ__=${bundleJson};
</script>
<script>
${staticVizJs}
</script>
</body>
</html>
`;
}

async function catalogWorkflowPath(cwd: string, name: string): Promise<string | undefined> {
  return (await listProjectWorkflowCatalog(cwd)).find(entry => entry.name === name)?.entryPath;
}

async function workspaceWorkflowPath(cwd: string, path: string): Promise<string | undefined> {
  if (!isWorkflowFile(path)) return undefined;
  const base = resolve(cwd);
  const candidate = resolveWorkspacePath(base, path);
  if (!candidate) return undefined;
  try {
    const [realBase, realCandidate, candidateStat] = await Promise.all([
      realpath(base),
      realpath(candidate),
      stat(candidate),
    ]);
    return candidateStat.isFile() && isContainedPath(realBase, realCandidate) ? candidate : undefined;
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function resolveWorkspacePath(base: string, path: string): string | undefined {
  if (isAbsolute(path) || path.includes("\0")) return undefined;
  const resolved = resolve(base, path || ".");
  const rel = relative(base, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? resolved : undefined;
}

function isWorkflowFile(path: string): boolean {
  return extname(path) === ".ts" || extname(path) === ".tsx";
}

function skipEntry(name: string): boolean {
  return name === "node_modules"
    || name === ".git"
    || name === "dist"
    || name === "build"
    || name === ".turbo"
    || name === ".next"
    || name === ".local";
}

async function isContainedFile(path: string, root: string): Promise<boolean> {
  try {
    const [info, real] = await Promise.all([stat(path), realpath(path)]);
    return info.isFile() && isContainedPath(root, real);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function workflowBrowseFailure(reason: WorkflowBrowseFailure["reason"], message: string): WorkflowBrowseFailure {
  return { type: "workflow-browse-invalid", reason, message };
}
