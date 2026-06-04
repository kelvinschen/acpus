import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ZodError } from "zod";
import { issue, type OrchestratorIssue } from "../errors.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "./workflow-spec.js";

export async function loadWorkflowSpec(filePath: string): Promise<{ spec?: WorkflowSpec; issues: OrchestratorIssue[] }> {
  if (!isWorkflowYamlPath(filePath)) {
    return {
      issues: [
        issue({
          code: "SCHEMA_FORMAT_UNSUPPORTED",
          severity: "error",
          path: "/",
          message: "Workflow specs must be authored as YAML files named *.workflow.spec.yaml, *.workflow.spec.yml, workflow.spec.yaml, or workflow.spec.yml.",
          suggestions: ["Rename the spec to *.workflow.spec.yaml or *.workflow.spec.yml and use YAML syntax."]
        })
      ]
    };
  }

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
          suggestions: ["Check that the spec file path exists and is readable."]
        })
      ]
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) as unknown;
  } catch (error) {
    return {
      issues: [
        issue({
          code: "SCHEMA_YAML_INVALID",
          severity: "error",
          path: "/",
          message: `Spec must be valid YAML: ${(error as Error).message}`,
          suggestions: ["Fix the YAML syntax and run validate again."]
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
          suggestions: ["Update the spec to match acpus.workflow/v1."]
        })
      )
    };
  }
}

export function stringifyWorkflowSpec(spec: WorkflowSpec): string {
  return YAML.stringify(spec, {
    aliasDuplicateObjects: false,
    lineWidth: 100
  });
}

export function isWorkflowYamlPath(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === "workflow.spec.yaml"
    || base === "workflow.spec.yml"
    || base.endsWith(".workflow.spec.yaml")
    || base.endsWith(".workflow.spec.yml");
}

function toJsonPointer(path: PropertyKey[]): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
