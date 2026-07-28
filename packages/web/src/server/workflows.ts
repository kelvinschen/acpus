import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import { staticExprShape } from "@acpus/expression/ir";
import { tryPrepareWorkflow, type WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type {
  ProjectWorkflowCatalogEntry,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
} from "../api-types.js";
import { workflowIrToWebGraph } from "./graph.js";
import { staticVizCss, staticVizJs } from "./static-viz-assets.generated.js";

export type WorkflowBrowseFailure = {
  type: "workflow-browse-invalid";
  reason: "outside-workspace" | "not-found" | "not-directory";
  message: string;
};

type WorkflowSourceFailure = {
  type: "workflow-source-invalid";
  reason: "outside-workspace" | "not-found" | "not-file" | "unsupported-extension";
  phase: "source";
  message: string;
};

type WorkflowVisualizationFailure = WorkflowSourceFailure | WorkflowPreparationFailure;

type ReadyWorkflowVisualization = Extract<WorkflowVisualizationResult, { status: "ready" }>;

const workflowCatalogName = /^[a-z0-9][a-z0-9-]*$/;

export async function listProjectWorkflowCatalog(cwd: string): Promise<ProjectWorkflowCatalogEntry[]> {
  const root = join(cwd, ".acpus", "workflows");
  let entries: string[];
  let realRoot: string;
  try {
    const realWorkspace = await realpath(resolve(cwd));
    realRoot = await realpath(root);
    if (!isContainedPath(realWorkspace, realRoot)) {
      throw new Error("Project workflow catalog resolves outside the workspace.");
    }
    entries = await readdir(root);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const catalog = await Promise.all(entries.map(async name => {
    if (!workflowCatalogName.test(name)) return undefined;
    const packagePath = join(root, name);
    const entryPath = join(packagePath, "workflow.ts");
    if (!await isContainedFile(entryPath, realRoot)) return undefined;
    return { name, entryPath };
  }));
  return catalog.flatMap(entry => entry ? [entry] : []).sort((left, right) => left.name.localeCompare(right.name));
}

export function listWorkflowFiles(cwd: string, dir = ""): ResultAsync<WorkflowFiles, WorkflowBrowseFailure> {
  return new ResultAsync(listWorkflowFilesResult(cwd, dir));
}

async function listWorkflowFilesResult(cwd: string, dir: string): Promise<Result<WorkflowFiles, WorkflowBrowseFailure>> {
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

export function tryVisualizeWorkflowSource(
  cwd: string,
  source: WorkflowVisualizationSource,
): ResultAsync<ReadyWorkflowVisualization, WorkflowVisualizationFailure> {
  return resolveWorkflowSource(cwd, source)
    .andThen(workflow => tryPrepareWorkflow({
      workspaceDir: cwd,
      source: { kind: "path", entry: workflow },
    }))
    .map(prepared => staticWorkflowVisualization(prepared.ir, prepared.sourceGraphDigest));
}

function staticWorkflowVisualization(ir: WorkflowIR, sourceGraphDigest: string): ReadyWorkflowVisualization {
  return {
    status: "ready",
    graph: workflowIrToWebGraph(ir),
    workflow: {
      name: ir.name,
      ...(ir.description === undefined ? {} : { description: ir.description }),
      irVersion: ir.irVersion,
      nodeCount: Array.from(walkNodes(ir.root)).length,
    },
    contract: {
      ...(ir.inputSchema === undefined ? {} : { inputSchema: ir.inputSchema }),
      output: ir.root.output,
      outputShape: staticExprShape(ir.root.output),
    },
    sourceGraphDigest,
  };
}

export type WorkflowVizHtmlOptions = {
  ir: WorkflowIR;
  sourceGraphDigest: string;
};

export function renderWorkflowVizHtml(options: WorkflowVizHtmlOptions): string {
  const { graph, workflow, contract, sourceGraphDigest } =
    staticWorkflowVisualization(options.ir, options.sourceGraphDigest);
  const bundle = { graph, workflow, contract, sourceGraphDigest };
  const bundleJson = JSON.stringify(bundle).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(workflow.name)}</title>
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

function resolveWorkflowSource(
  cwd: string,
  source: WorkflowVisualizationSource,
): ResultAsync<string, WorkflowSourceFailure> {
  return new ResultAsync(source.kind === "catalog"
    ? catalogWorkflowPath(cwd, source.name)
    : workspaceWorkflowPath(cwd, source.path));
}

async function catalogWorkflowPath(cwd: string, name: string): Promise<Result<string, WorkflowSourceFailure>> {
  if (!workflowCatalogName.test(name)) return err(workflowSourceFailure("not-found"));
  const base = resolve(cwd);
  const root = join(base, ".acpus", "workflows");
  let realRoot: string;
  try {
    const realBase = await realpath(base);
    realRoot = await realpath(root);
    if (!isContainedPath(realBase, realRoot)) {
      return err(workflowSourceFailure("outside-workspace"));
    }
  } catch (error) {
    if (isMissingPathError(error)) return err(workflowSourceFailure("not-found"));
    throw error;
  }

  const workflow = join(root, name, "workflow.ts");
  try {
    const [info, realWorkflow] = await Promise.all([stat(workflow), realpath(workflow)]);
    if (!info.isFile()) return err(workflowSourceFailure("not-file"));
    return isContainedPath(realRoot, realWorkflow)
      ? ok(workflow)
      : err(workflowSourceFailure("outside-workspace"));
  } catch (error) {
    if (isMissingPathError(error)) return err(workflowSourceFailure("not-found"));
    throw error;
  }
}

async function workspaceWorkflowPath(cwd: string, path: string): Promise<Result<string, WorkflowSourceFailure>> {
  if (!isWorkflowFile(path)) return err(workflowSourceFailure("unsupported-extension"));
  const base = resolve(cwd);
  const candidate = resolveWorkspacePath(base, path);
  if (!candidate) return err(workflowSourceFailure("outside-workspace"));
  try {
    const [realBase, realCandidate, candidateStat] = await Promise.all([
      realpath(base),
      realpath(candidate),
      stat(candidate),
    ]);
    if (!candidateStat.isFile()) return err(workflowSourceFailure("not-file"));
    return isContainedPath(realBase, realCandidate)
      ? ok(candidate)
      : err(workflowSourceFailure("outside-workspace"));
  } catch (error) {
    if (isMissingPathError(error)) return err(workflowSourceFailure("not-found"));
    throw error;
  }
}

function resolveWorkspacePath(base: string, path: string): string | undefined {
  if (isAbsolute(path) || path.includes("\0")) return undefined;
  const resolved = resolve(base, path || ".");
  return isContainedPath(base, resolved) ? resolved : undefined;
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

function workflowSourceFailure(reason: WorkflowSourceFailure["reason"]): WorkflowSourceFailure {
  return {
    type: "workflow-source-invalid",
    reason,
    phase: "source",
    message: "Workflow source was not found.",
  };
}
