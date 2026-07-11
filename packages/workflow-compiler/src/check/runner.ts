import { readFile } from "node:fs/promises";
import type { DiagnosticIR } from "@acpus/core/ir";
import { analyzeWorkflowTasks } from "../task-analysis/index.js";
import { checkWorkflowAuthoring } from "./authoring-rules/index.js";
import { checkTypeScript } from "./typescript.js";

export type WorkflowCheckResult = {
  diagnostics: DiagnosticIR[];
};

export async function checkWorkflow(entry: string, cwd: string, scratchDir: string): Promise<WorkflowCheckResult> {
  let source: string;
  try {
    source = await readFile(entry, "utf8");
  } catch (error) {
    return { diagnostics: [workflowReadDiagnostic(entry, error)] };
  }

  const tsCheck = await checkTypeScript(entry, cwd, scratchDir);
  const taskAnalysis = await analyzeWorkflowTasks(entry, source);
  // The check phase aggregates TypeScript compiler diagnostics with Acpus
  // authoring-rule diagnostics.
  const authoringDiagnostics = tsCheck.program && tsCheck.sourceFile
    ? checkWorkflowAuthoring({ program: tsCheck.program, sourceFile: tsCheck.sourceFile, taskAnalysis })
    : [];
  return { diagnostics: [...tsCheck.diagnostics, ...authoringDiagnostics] };
}

function workflowReadDiagnostic(entry: string, error: unknown): DiagnosticIR {
  return {
    code: "WF001",
    severity: "error",
    message: `Workflow source could not be read: ${error instanceof Error ? error.message : String(error)}`,
    path: "workflow",
    source: {
      file: entry,
      line: 1,
      column: 1,
    },
  };
}
