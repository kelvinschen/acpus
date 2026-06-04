import fs from "node:fs/promises";
import path from "node:path";
import { resultFromIssues, type IssueResult } from "../errors.js";
import { lintWorkflowSpec } from "../compiler/lint.js";
import { loadWorkflowSpec } from "../schema/load.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { globalWorkflowsDir, projectWorkflowsDir } from "../run-index/paths.js";

export type CommandGlobalOptions = {
  json?: boolean;
};

export async function resolveSpecArg(
  options: { spec?: string; global?: boolean }
): Promise<string> {
  if (options.spec) {
    const hasPathSeparator = options.spec.includes("/") || options.spec.includes("\\");
    const hasSpecExtension =
      options.spec.endsWith(".yaml") || options.spec.endsWith(".yml");
    const hasUnsupportedSpecExtension =
      options.spec.endsWith(".json") || options.spec.endsWith(".workflow.spec.json");
    if (hasPathSeparator || hasSpecExtension || hasUnsupportedSpecExtension) {
      return options.spec;
    }
    // Bare name without path separators or spec extension: treat as saved workflow name.
    return path.join(
      options.global ? globalWorkflowsDir() : projectWorkflowsDir(),
      options.spec,
      "workflow.spec.yaml"
    );
  }
  throw new Error("Provide a spec file path or workflow name.");
}

export async function loadAndLint(specPath: string): Promise<{
  spec?: WorkflowSpec;
  result: IssueResult;
}> {
  const loaded = await loadWorkflowSpec(specPath);
  if (!loaded.spec) {
    return { result: resultFromIssues("spec", loaded.issues) };
  }
  const issues = [...loaded.issues, ...lintWorkflowSpec(loaded.spec)];
  return {
    spec: loaded.spec,
    result: resultFromIssues("spec", issues)
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printIssues(result: IssueResult): void {
  if (result.ok) {
    process.stdout.write("ok\n");
  }
  for (const warning of result.warnings) {
    process.stdout.write(`warning ${warning.code} ${warning.path}: ${warning.message}\n`);
  }
  for (const error of result.errors) {
    process.stderr.write(`${error.severity} ${error.code} ${error.path}: ${error.message}\n`);
    for (const suggestion of error.suggestions ?? []) {
      process.stderr.write(`  suggestion: ${suggestion}\n`);
    }
  }
}

export async function ensureEmptyOrOverwrite(target: string, overwrite?: boolean): Promise<void> {
  try {
    await fs.stat(target);
    if (!overwrite) {
      throw new Error(`Target already exists: ${target}. Use --overwrite.`);
    }
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return parseJsonObject(await fs.readFile(filePath, "utf8"), filePath);
}

export async function readInputArg(value: string): Promise<Record<string, unknown>> {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{")) return parseJsonObject(value, "--input");
  return readJsonFile(trimmed);
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: invalid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}
