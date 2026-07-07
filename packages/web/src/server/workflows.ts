import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { WorkflowIR } from "@acpus/core/ir";
import { prepareWorkflow, WorkflowPreparationError, type PreparedWorkflow } from "@acpus/workflow-compiler";
import { workflowIrToWebGraph, type WebGraph } from "./graph.js";
import { staticVizCss, staticVizJs } from "./static-viz-assets.generated.js";

export type ProjectWorkflowCatalogEntry = {
  scope: "project";
  name: string;
  packagePath: string;
  entryPath: string;
  status: "available";
  requiresScope: boolean;
};

export type WorkflowFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "workflow";
};

export type WorkflowVisualizationSource =
  | { kind: "catalog"; name: string }
  | { kind: "file"; path: string };

export type WorkflowVisualizationResult =
  | {
    status: "ready";
    graph: WebGraph;
    workflow: { name: string; irVersion: number; nodeCount: number };
    contract: { inputSchema?: WorkflowIR["inputSchema"]; outputs: WorkflowIR["outputs"] };
    diagnostics: WorkflowIR["diagnostics"];
    irDigest: string;
    sourceGraphDigest: string;
  }
  | {
    status: "failed";
    phase: "check" | "compile" | "validate";
    message: string;
    diagnostics?: WorkflowIR["diagnostics"];
  };

export async function listProjectWorkflowCatalog(cwd: string): Promise<ProjectWorkflowCatalogEntry[]> {
  const root = join(cwd, ".acpus", "workflows");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const catalog = await Promise.all(entries.map(async name => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
    const packagePath = join(root, name);
    const entryPath = join(packagePath, "workflow.ts");
    if (!await isFile(entryPath)) return undefined;
    return {
      scope: "project" as const,
      name,
      packagePath,
      entryPath,
      status: "available" as const,
      requiresScope: false,
    };
  }));
  return catalog.flatMap(entry => entry ? [entry] : []).sort((left, right) => left.name.localeCompare(right.name));
}

export async function listWorkflowFiles(cwd: string, dir = ""): Promise<{ cwd: string; dir: string; entries: WorkflowFileEntry[] }> {
  const base = resolve(cwd);
  const current = resolveWorkspacePath(base, dir);
  if (!current) throw new Error("Path escapes workspace.");
  const currentStat = await stat(current);
  if (!currentStat.isDirectory()) throw new Error("Path is not a directory.");

  const entries = await Promise.all((await readdir(current, { withFileTypes: true }))
    .filter(entry => !skipEntry(entry.name))
    .map(async entry => {
      const absolute = join(current, entry.name);
      const rel = relative(base, absolute);
      if (entry.isDirectory()) return { name: entry.name, path: rel, kind: "directory" as const };
      return isWorkflowFile(entry.name) ? { name: entry.name, path: rel, kind: "workflow" as const } : undefined;
    }));
  return {
    cwd: base,
    dir: relative(base, current),
    entries: entries.flatMap(entry => entry ? [entry] : []).sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    ),
  };
}

export async function visualizeWorkflowSource(cwd: string, source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  const workflow = source.kind === "catalog"
    ? (await catalogWorkflowPath(cwd, source.name))
    : workspaceWorkflowPath(cwd, source.path);
  if (!workflow) {
    return { status: "failed", phase: "compile", message: "Workflow source was not found." };
  }

  try {
    const prepared = await prepareWorkflow({ cwd, workflow });
    return workflowVisualizationFromPrepared(prepared);
  } catch (error) {
    if (error instanceof WorkflowPreparationError) {
      return {
        status: "failed",
        phase: error.failure.phase,
        message: error.failure.message,
        ...("diagnostics" in error.failure ? { diagnostics: error.failure.diagnostics } : {}),
      };
    }
    return { status: "failed", phase: "compile", message: error instanceof Error ? error.message : String(error) };
  }
}

export function workflowVisualizationFromPrepared(prepared: PreparedWorkflow): Extract<WorkflowVisualizationResult, { status: "ready" }> {
  return {
    status: "ready",
    graph: workflowIrToWebGraph(prepared.ir),
    workflow: {
      name: prepared.ir.name,
      irVersion: prepared.ir.irVersion,
      nodeCount: countNodes(prepared.ir.root),
    },
    contract: {
      ...(prepared.ir.inputSchema === undefined ? {} : { inputSchema: prepared.ir.inputSchema }),
      outputs: prepared.ir.outputs,
    },
    diagnostics: prepared.ir.diagnostics,
    irDigest: prepared.irDigest,
    sourceGraphDigest: prepared.sourceGraphDigest,
  };
}

export type WorkflowVizHtmlOptions = {
  graph: WebGraph;
  title?: string;
  workflow?: Extract<WorkflowVisualizationResult, { status: "ready" }>["workflow"];
  contract?: Extract<WorkflowVisualizationResult, { status: "ready" }>["contract"];
  diagnostics?: Extract<WorkflowVisualizationResult, { status: "ready" }>["diagnostics"];
  irDigest?: string;
  sourceGraphDigest?: string;
};

export function renderWorkflowVizHtml(options: WorkflowVizHtmlOptions): string {
  const title = options.title ?? options.graph.workflow.name;
  const bundle = {
    title,
    graph: options.graph,
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.contract ? { contract: options.contract } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.irDigest ? { irDigest: options.irDigest } : {}),
    ...(options.sourceGraphDigest ? { sourceGraphDigest: options.sourceGraphDigest } : {}),
  };
  const bundleJson = JSON.stringify(bundle).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
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

export async function writeWorkflowVizHtml(path: string, html: string, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && await exists(path)) throw new Error(`Output file already exists: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html);
}

async function catalogWorkflowPath(cwd: string, name: string): Promise<string | undefined> {
  return (await listProjectWorkflowCatalog(cwd)).find(entry => entry.name === name)?.entryPath;
}

function workspaceWorkflowPath(cwd: string, path: string): string | undefined {
  if (!isWorkflowFile(path)) return undefined;
  return resolveWorkspacePath(resolve(cwd), path);
}

function resolveWorkspacePath(base: string, path: string): string | undefined {
  if (path.startsWith("/") || path.includes("\0")) return undefined;
  const resolved = resolve(base, path || ".");
  const rel = relative(base, resolved);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")) ? resolved : undefined;
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function countNodes(scope: WorkflowIR["root"]): number {
  return scope.nodes.reduce((total, node) => {
    if (node.kind === "if") return total + 1 + countNodes(node.then) + (node.else ? countNodes(node.else) : 0);
    if (node.kind === "switch") return total + 1 + node.cases.reduce((sum, branch) => sum + countNodes(branch.then), 0) + countNodes(node.default);
    if (node.kind === "parallel") return total + 1 + Object.values(node.branches).reduce((sum, branch) => sum + countNodes(branch.scope), 0);
    if (node.kind === "fanout") return total + 1 + countNodes(node.do);
    if (node.kind === "loop") return total + 1 + countNodes(node.do);
    return total + 1;
  }, 0);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
