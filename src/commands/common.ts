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

export async function loadAndLint(specPath: string): Promise<{
  spec?: WorkflowSpec;
  result: IssueResult;
}> {
  const loaded = await loadWorkflowSpec(specPath);
  if (!loaded.spec) {
    return { result: resultFromIssues("validate", loaded.issues) };
  }
  const issues = [...loaded.issues, ...lintWorkflowSpec(loaded.spec)];
  return {
    spec: loaded.spec,
    result: resultFromIssues("validate", issues)
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
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

export function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

export function resolveSpecPath(options: { spec?: string; workflow?: string; global?: boolean }): string {
  if (options.spec && options.workflow) {
    throw new Error("Use only one of --spec or --workflow.");
  }
  if (options.spec) return options.spec;
  if (options.workflow) {
    return path.join(options.global ? globalWorkflowsDir() : projectWorkflowsDir(), options.workflow, "workflow.spec.json");
  }
  throw new Error("Provide --spec <path> or --workflow <name>.");
}
