import { readFile } from "node:fs/promises";
import type { DiagnosticIR } from "@acpus/core/ir";
import { checkTypeScript } from "./typescript.js";
import type { TypeScriptNativeFailure } from "../typescript/native.js";
import { sha256Digest } from "../digest.js";

export type WorkflowCheckResult = {
  diagnostics: DiagnosticIR[];
  sourceDigest?: string;
};

export async function checkWorkflow(entry: string, cwd: string, scratchDir: string): Promise<WorkflowCheckResult> {
  let source: string;
  try {
    source = await readFile(entry, "utf8");
  } catch (error) {
    return { diagnostics: [workflowReadDiagnostic(entry, error)] };
  }

  const result = await checkTypeScript(entry, cwd, scratchDir, source);
  const sourceDigest = sha256Digest(source);
  return result.match(
    value => ({ ...value, sourceDigest }),
    failure => ({ diagnostics: [typescriptNativeDiagnostic(entry, failure)], sourceDigest }),
  );
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

export function typescriptNativeDiagnostic(entry: string, error: TypeScriptNativeFailure): DiagnosticIR {
  return {
    code: "WF002",
    severity: "error",
    message: error.message,
    path: "workflow",
    source: {
      file: entry,
      line: 1,
      column: 1,
    },
  };
}
