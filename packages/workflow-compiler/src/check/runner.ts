import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import type { DiagnosticIR } from "@acpus/core/ir";
import { checkTypeScript } from "./typescript.js";
import type { TypeScriptNativeFailure } from "../typescript/native.js";
import type { CheckedSourceFile } from "./source-capture.js";

export type WorkflowCheckResult = {
  diagnostics: DiagnosticIR[];
  sourceDigest?: Sha256Digest;
  sourceFiles?: CheckedSourceFile[];
  packageImportReferrers?: string[];
};

export async function checkWorkflow(
  entry: string,
  cwd: string,
  scratchDir: string,
  options: { dependencyFallback?: boolean } = {},
): Promise<WorkflowCheckResult> {
  let source: string;
  try {
    source = await readFile(entry, "utf8");
  } catch (error) {
    return { diagnostics: [workflowReadDiagnostic(entry, error)] };
  }

  const result = await checkTypeScript(entry, cwd, scratchDir, source, options);
  const sourceDigest = sha256Digest(source);
  if (result.isErr()) {
    return { diagnostics: [typescriptNativeDiagnostic(entry, result.error)], sourceDigest };
  }
  const entryPath = resolve(entry);
  const sourceFiles = await Promise.all(result.value.sourceFiles.map(async file => {
    if (resolve(file.path) === entryPath) return { ...file, content: source };
    try {
      return { ...file, content: await readFile(file.path, "utf8") };
    } catch {
      return file;
    }
  }));
  return { ...result.value, sourceFiles, sourceDigest };
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
