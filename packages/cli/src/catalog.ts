import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { lintWorkflow, type Diagnostic, type LintResult } from "@acpus/core";
import { createIncludeResolver } from "./io.js";

export type WorkflowCatalogScope = "project" | "global";
export type WorkflowCatalogStatus = "ready" | "invalid" | "conflict";

export interface WorkflowCatalogEntry {
  scope: WorkflowCatalogScope;
  ref?: string;
  name?: string;
  description?: string;
  input?: Record<string, unknown>;
  inputKeys: string[];
  path: string;
  status: WorkflowCatalogStatus;
  diagnostics: Diagnostic[];
}

export interface ResolvedWorkflowTarget {
  sourcePath: string;
  source: string;
  workflowRef?: string;
}

export function projectWorkflowRoot(workspace = process.cwd()): string {
  return resolve(workspace, ".acpus", "workflows");
}

export function globalWorkflowRoot(): string {
  return resolve(homedir(), ".acpus", "workflows");
}

export function listWorkflowCatalog(workspace = process.cwd()): WorkflowCatalogEntry[] {
  const allowedSourceRoots = [resolve(workspace), globalWorkflowRoot()];
  const entries = [
    ...scanScope("project", projectWorkflowRoot(workspace), allowedSourceRoots),
    ...scanScope("global", globalWorkflowRoot(), allowedSourceRoots)
  ];

  for (const scope of ["project", "global"] as const) {
    const byName = new Map<string, WorkflowCatalogEntry[]>();
    for (const entry of entries) {
      if (entry.scope !== scope || !entry.name || entry.status === "invalid") continue;
      const group = byName.get(entry.name) ?? [];
      group.push(entry);
      byName.set(entry.name, group);
    }
    for (const [name, group] of byName) {
      if (group.length <= 1) continue;
      for (const entry of group) {
        entry.status = "conflict";
        entry.ref = undefined;
        entry.diagnostics = [{
          severity: "error",
          code: "CATALOG_CONFLICT",
          message: `Workflow name '${name}' is duplicated in ${scope} catalog.`,
          path: "$.name"
        }];
      }
    }
  }

  return entries;
}

export function resolveWorkflowTarget(target: string, workspace = process.cwd()): ResolvedWorkflowTarget {
  if (looksLikeWorkflowPath(target)) {
    const sourcePath = resolveWorkflowPath(target);
    return { sourcePath, source: readFileSync(sourcePath, "utf8") };
  }

  const catalog = listWorkflowCatalog(workspace);
  const matches = catalog.filter((entry) => entry.status === "ready" && matchesCatalogTarget(entry, target));
  if (matches.length === 0) {
    const blocked = catalog.find((entry) => matchesCatalogTarget(entry, target));
    if (blocked) {
      throw new Error(`Workflow '${target}' is ${blocked.status}: ${blocked.diagnostics.map((d) => d.message).join("; ")}`);
    }
    throw new Error(`Workflow '${target}' was not found in the Workflow Catalog.`);
  }
  if (matches.length > 1) {
    throw new Error(`Workflow short name '${target}' is ambiguous; use a full ref such as ${matches.map((m) => m.ref).join(" or ")}.`);
  }

  const entry = matches[0];
  return {
    sourcePath: entry.path,
    source: readFileSync(entry.path, "utf8"),
    workflowRef: entry.ref
  };
}

export function findWorkflowCatalogEntry(target: string, workspace = process.cwd()): WorkflowCatalogEntry {
  const catalog = listWorkflowCatalog(workspace);
  const matches = catalog.filter((entry) => matchesCatalogTarget(entry, target));
  if (matches.length === 0) {
    throw new Error(`Workflow '${target}' was not found in the Workflow Catalog.`);
  }
  if (matches.length > 1) {
    throw new Error(`Workflow name '${target}' is ambiguous; use a full ref when available.`);
  }
  return matches[0];
}

function matchesCatalogTarget(entry: WorkflowCatalogEntry, target: string): boolean {
  return entry.ref === target || entry.name === target || (entry.name !== undefined && `${entry.scope}:${entry.name}` === target);
}

function scanScope(scope: WorkflowCatalogScope, root: string, allowedSourceRoots: string[]): WorkflowCatalogEntry[] {
  if (!existsSync(root)) return [];
  const files = collectCandidateFiles(root);
  return files.map((file) => entryFromFile(scope, file, allowedSourceRoots));
}

function collectCandidateFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && isWorkflowCandidate(entry.name)) {
        out.push(path);
      }
    }
  };
  visit(root);
  return out.sort();
}

function entryFromFile(scope: WorkflowCatalogScope, path: string, allowedSourceRoots: string[]): WorkflowCatalogEntry {
  const source = readFileSync(path, "utf8");
  const parsed = parseSpecSummary(source);
  const lint = lintCatalogEntry(source, path, allowedSourceRoots);
  const name = parsed.name;
  const status: WorkflowCatalogStatus = lint.ok && name ? "ready" : "invalid";

  return {
    scope,
    ref: status === "ready" ? `${scope}:${name}` : undefined,
    name,
    description: parsed.description,
    input: parsed.input,
    inputKeys: Object.keys(parsed.input ?? {}),
    path,
    status,
    diagnostics: lint.ok && !name
      ? [{ severity: "error", code: "CATALOG_NAME", message: "Workflow Spec must declare a string name.", path: "$.name" }]
      : lint.diagnostics
  };
}

function lintCatalogEntry(source: string, path: string, allowedSourceRoots: string[]): LintResult {
  try {
    return lintWorkflow(source, {
      sourcePath: path,
      includeResolver: createIncludeResolver(allowedSourceRoots)
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        code: "CATALOG_LINT",
        message: error instanceof Error ? error.message : String(error),
        path: "$"
      }]
    };
  }
}

function parseSpecSummary(source: string): { name?: string; description?: string; input?: Record<string, unknown> } {
  try {
    const parsed = parseYaml(source) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map = parsed as Record<string, unknown>;
    return {
      name: typeof map.name === "string" ? map.name : undefined,
      description: typeof map.description === "string" ? map.description : undefined,
      input: typeof map.input === "object" && map.input !== null && !Array.isArray(map.input)
        ? map.input as Record<string, unknown>
        : undefined
    };
  } catch {
    return {};
  }
}

function isWorkflowCandidate(filename: string): boolean {
  return filename === "workflow.yaml"
    || filename === "workflow.yml"
    || filename.endsWith(".workflow.yaml")
    || filename.endsWith(".workflow.yml")
    || filename.endsWith(".workflow.spec.yaml")
    || filename.endsWith(".workflow.spec.yml");
}

export function looksLikeWorkflowPath(target: string): boolean {
  return target.startsWith(".")
    || target.startsWith("/")
    || target.startsWith("~")
    || target.includes("/")
    || target.endsWith(".yaml")
    || target.endsWith(".yml");
}

export function resolveWorkflowPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Workflow Spec path not found: ${path}`);
  }
  return resolved;
}
