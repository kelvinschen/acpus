import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { usageError } from "../errors.js";
import type { InitOptions, InitResult } from "./types.js";

const catalogNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const starterNameMarker = 'name: "acpus-workflow-starter",';
const starterUrl = new URL("../../templates/workflow-init/starter.workflow.ts", import.meta.url);

export async function writeWorkflowInit(cwd: string, options: InitOptions): Promise<InitResult> {
  const path = await resolveInitPath(cwd, options);
  const workflowName = options.target === "catalog"
    ? options.destination
    : workflowNameFromFile(path);
  const source = await renderStarter(workflowName);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, { flag: "wx" });
  } catch (error) {
    if (isExistingPath(error)) throw usageError(`Workflow init target already exists: ${path}`);
    throw usageError(`Workflow init target could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { target: options.target, path };
}

async function resolveInitPath(cwd: string, options: InitOptions): Promise<string> {
  if (options.target === "file") return resolveInitFile(cwd, options.destination);
  return resolveInitCatalog(cwd, options.destination);
}

async function resolveInitFile(cwd: string, file: string): Promise<string> {
  if (!file.endsWith(".ts")) throw usageError("Workflow init file target must end with .ts.");
  const path = resolve(cwd, file);
  if (await exists(path)) throw usageError(`Workflow init target already exists: ${path}`);
  return path;
}

async function resolveInitCatalog(cwd: string, name: string): Promise<string> {
  if (!catalogNamePattern.test(name)) throw usageError(`Workflow catalog name '${name}' must match ${catalogNamePattern.source}.`);
  const packagePath = join(cwd, ".acpus", "workflows", name);
  if (await exists(packagePath)) throw usageError(`Workflow catalog package already exists: ${packagePath}`);
  return join(packagePath, "workflow.ts");
}

async function renderStarter(workflowName: string): Promise<string> {
  const template = await readFile(starterUrl, "utf8");
  if (!template.includes(starterNameMarker)) throw new Error("Workflow starter name marker is missing.");
  return template.replace(starterNameMarker, `name: ${JSON.stringify(workflowName)},`);
}

function workflowNameFromFile(path: string): string {
  const normalized = basename(path, ".ts")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "workflow";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isExistingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
