import { issue, type OrchestratorIssue } from "../errors.js";
import type { WorkflowSpec } from "./workflow-spec.js";

export function validateInputDefaults(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (const [name, declaration] of Object.entries(spec.inputs)) {
    if (declaration.default === undefined) continue;
    const message = inputTypeError(declaration.default, declaration.type);
    if (!message) continue;
    issues.push(issue({
      code: "SCHEMA_INPUT_DEFAULT_TYPE_INVALID",
      severity: "error",
      path: `/inputs/${escapePointer(name)}/default`,
      message: `Default for input ${name} does not match type ${declaration.type}: ${message}`,
      suggestions: [`Update /inputs/${name}/default or change /inputs/${name}/type.`]
    }));
  }
  return issues;
}

export function validateWorkflowInput(spec: WorkflowSpec, input: Record<string, unknown>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (spec.inputs[name]) continue;
    issues.push(issue({
      code: "SCHEMA_INPUT_UNKNOWN",
      severity: "warning",
      path: `/input/${escapePointer(name)}`,
      message: `Input ${name} is not declared in workflow spec.`,
      suggestions: ["Declare the input if a stage should rely on it, or remove it from the run input."]
    }));
  }
  for (const [name, declaration] of Object.entries(spec.inputs)) {
    const value = input[name];
    if (value === undefined) continue;
    const message = inputTypeError(value, declaration.type);
    if (!message) continue;
    issues.push(issue({
      code: "SCHEMA_INPUT_TYPE_INVALID",
      severity: "error",
      path: `/input/${escapePointer(name)}`,
      message: `Input ${name} does not match type ${declaration.type}: ${message}`,
      suggestions: [`Provide a ${declaration.type} value for input ${name}.`]
    }));
  }
  return issues;
}

export function applyInputDefaults(spec: WorkflowSpec, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(spec.inputs).map(([key, value]) => [key, value.default])),
    ...input
  };
}

function inputTypeError(value: unknown, type: string): string | undefined {
  switch (type) {
    case "string":
    case "path":
    case "glob":
      return typeof value === "string" ? undefined : "expected string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "expected finite number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected boolean";
    case "json":
      return isSerializable(value) ? undefined : "expected JSON-serializable value";
    case "array<string>":
    case "array<path>":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "expected string array";
    case "array<json>":
      return Array.isArray(value) && value.every(isSerializable) ? undefined : "expected JSON-serializable array";
    default:
      return undefined;
  }
}

function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
