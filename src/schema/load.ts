import fs from "node:fs/promises";
import { ZodError } from "zod";
import { issue, type OrchestratorIssue } from "../errors.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "./workflow-spec.js";

export async function loadWorkflowSpec(filePath: string): Promise<{ spec?: WorkflowSpec; issues: OrchestratorIssue[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return {
      issues: [
        issue({
          code: "SCHEMA_FILE_READ_FAILED",
          severity: "fatal",
          path: "/",
          message: `Unable to read spec file: ${(error as Error).message}`,
          suggestions: ["Check that the --spec path exists and is readable."]
        })
      ]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      issues: [
        issue({
          code: "SCHEMA_JSON_INVALID",
          severity: "error",
          path: "/",
          message: `Spec must be valid JSON: ${(error as Error).message}`,
          suggestions: ["Fix the JSON syntax and run validate again."]
        })
      ]
    };
  }

  try {
    return { spec: WorkflowSpecSchema.parse(parsed), issues: [] };
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    return {
      issues: error.issues.map((entry) =>
        issue({
          code: entry.path.length === 1 && entry.path[0] === "schemaVersion"
            ? "SCHEMA_VERSION_UNSUPPORTED"
            : "SCHEMA_VALIDATION_FAILED",
          severity: "error",
          path: toJsonPointer(entry.path),
          message: entry.message,
          suggestions: ["Update the spec to match acpx-workflow-orchestrator.workflow/v1."]
        })
      )
    };
  }
}

function toJsonPointer(path: PropertyKey[]): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
