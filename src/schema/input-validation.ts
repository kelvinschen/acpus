import { issue, type OrchestratorIssue } from "../errors.js";
import { compileSchemaDsl, zodForCompiledSchema, type CompiledSchema } from "../contracts/schema-dsl.js";
import type { WorkflowSpec } from "./workflow-spec.js";
import { validateInputSourcedLimits } from "./limit-resolution.js";

export function validateInputSchema(spec: WorkflowSpec): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const compiled = compileWorkflowInputSchema(spec, "/input/schema");
  if (!compiled.ok) return [compiled.issue];
  if (!spec.input || spec.input.default === undefined) return issues;
  const result = compiled.schema.safeParse(spec.input.default);
  if (result.success) return issues;
  issues.push(...zodIssuesToInputIssues(result.error.issues, "INPUT_DEFAULT_SCHEMA_INVALID", "/input/default"));
  return issues;
}

export function validateWorkflowInput(spec: WorkflowSpec, input: Record<string, unknown>): OrchestratorIssue[] {
  const compiled = compileWorkflowInputSchema(spec, "/input/schema");
  if (!compiled.ok) return [compiled.issue];
  const result = compiled.schema.safeParse(input);
  if (!result.success) return zodIssuesToInputIssues(result.error.issues, "INPUT_SCHEMA_INVALID", "/input");
  return validateInputSourcedLimits(spec, input);
}

export function applyInputDefaults(spec: WorkflowSpec, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(spec.input?.default ?? {}),
    ...input
  };
}

export function declaredInputFields(spec: WorkflowSpec): Set<string> | undefined {
  if (!spec.input) return new Set();
  try {
    const compiled = compileSchemaDsl(spec.input.schema);
    if (compiled.ast.kind !== "object") return undefined;
    return new Set(compiled.ast.fields.map((field) => field.name));
  } catch {
    return undefined;
  }
}

function compileWorkflowInputSchema(spec: WorkflowSpec, path: string): { ok: true; schema: ReturnType<typeof zodForCompiledSchema>; compiled?: CompiledSchema } | { ok: false; issue: OrchestratorIssue } {
  if (!spec.input) {
    return {
      ok: true,
      schema: zodForCompiledSchema({ source: "{}", ast: { kind: "object", fields: [] } })
    };
  }
  try {
    const compiled = compileSchemaDsl(spec.input.schema);
    return { ok: true, schema: zodForCompiledSchema(compiled), compiled };
  } catch (error) {
    return {
      ok: false,
      issue: issue({
        code: "INPUT_SCHEMA_DSL_INVALID",
        severity: "error",
        path,
        message: `Input schema DSL is invalid: ${(error as Error).message}`,
        suggestions: ["Use an object-root schema with primitives, literals, arrays, objects, optional keys, and unions."]
      })
    };
  }
}

function zodIssuesToInputIssues(issues: Array<{ code: string; path: PropertyKey[]; message: string }>, defaultCode: string, basePath: string): OrchestratorIssue[] {
  return issues.map((entry) => {
    const path = `${basePath}${entry.path.map((part) => `/${escapePointer(String(part))}`).join("")}`;
    const code = inputIssueCode(entry, defaultCode);
    return issue({
      code,
      severity: "error",
      path,
      message: inputIssueMessage(code, entry.message),
      suggestions: [inputIssueSuggestion(code)]
    });
  });
}

function inputIssueCode(entry: { code: string; message: string }, defaultCode: string): string {
  if (entry.code === "unrecognized_keys") return "INPUT_UNKNOWN";
  if (entry.code === "invalid_type" && entry.message.includes("undefined")) return "INPUT_REQUIRED";
  return defaultCode;
}

function inputIssueMessage(code: string, message: string): string {
  if (code === "INPUT_UNKNOWN") return `Input contains undeclared fields: ${message}`;
  if (code === "INPUT_REQUIRED") return `Required input field is missing or invalid: ${message}`;
  return `Input does not satisfy schema: ${message}`;
}

function inputIssueSuggestion(code: string): string {
  if (code === "INPUT_UNKNOWN") return "Remove undeclared input fields or declare them in /input/schema.";
  if (code === "INPUT_REQUIRED") return "Provide the required field or mark it optional in /input/schema.";
  return "Update the input value to satisfy /input/schema.";
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
