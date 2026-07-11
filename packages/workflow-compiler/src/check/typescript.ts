import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { officialAuthoringTypeScriptPaths } from "@acpus/loader";
import type { DiagnosticIR } from "@acpus/core/ir";
import { err, type Result } from "neverthrow";
import type { SourceFile } from "typescript/unstable/ast";
import { DiagnosticCategory, type Diagnostic, type Program } from "typescript/unstable/sync";
import { analyzeWorkflowTasksFromSourceFile } from "../task-analysis/index.js";
import { nativeFailure, withNativeProject, type TypeScriptNativeFailure } from "../typescript/native.js";
import { checkWorkflowAuthoring } from "./authoring-rules/index.js";

export type TypeScriptCheck = {
  diagnostics: DiagnosticIR[];
};

export async function checkTypeScript(
  entry: string,
  cwd: string,
  scratchDir: string,
  source: string,
): Promise<Result<TypeScriptCheck, TypeScriptNativeFailure>> {
  let tsconfig: string;
  try {
    tsconfig = await writeTypecheckConfig(entry, cwd, scratchDir);
  } catch (cause) {
    return err(nativeFailure(cause));
  }
  return withNativeProject({ configPath: tsconfig, cwd, sourcePath: entry, source }, ({ project, sourceFile }) => {
    const program = project.program;
    const diagnostics = deduplicateDiagnostics([
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ]).map(diagnostic => toDiagnosticIR(diagnostic, program));
    const taskAnalysis = analyzeWorkflowTasksFromSourceFile(entry, sourceFile);
    diagnostics.push(...checkWorkflowAuthoring({ project, sourceFile, taskAnalysis }));
    return { diagnostics };
  });
}

export function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = JSON.stringify([
      diagnostic.category,
      diagnostic.code,
      diagnostic.fileName ?? "",
      diagnostic.pos,
      diagnostic.end,
      flattenDiagnosticMessage(diagnostic),
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toDiagnosticIR(diagnostic: Diagnostic, program: Program): DiagnosticIR {
  const result: DiagnosticIR = {
    code: `TS${diagnostic.code}`,
    severity: diagnostic.category === DiagnosticCategory.Warning ? "warning" : "error",
    message: flattenDiagnosticMessage(diagnostic),
  };
  if (diagnostic.fileName && diagnostic.pos >= 0) {
    const file = program.getSourceFile(diagnostic.fileName);
    if (file) result.source = sourceLocation(file, diagnostic.pos);
  }
  return result;
}

function flattenDiagnosticMessage(diagnostic: Diagnostic): string {
  return [
    diagnostic.text,
    ...(diagnostic.messageChain ?? []).map(flattenDiagnosticMessage),
  ].filter(Boolean).join("\n");
}

function sourceLocation(file: SourceFile, start: number): NonNullable<DiagnosticIR["source"]> {
  const position = file.getLineAndCharacterOfPosition(start);
  return {
    file: file.fileName,
    line: position.line + 1,
    column: position.character + 1,
  };
}

async function writeTypecheckConfig(entry: string, cwd: string, scratchDir: string): Promise<string> {
  const configPath = join(scratchDir, "tsconfig.acpus-run.json");
  const compilerOptions: Record<string, unknown> = {
    target: "ES2022",
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    esModuleInterop: true,
    noImplicitAny: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
    typeRoots: typeRoots(cwd),
  };

  const officialImports = officialAuthoringTypeScriptPaths(scratchDir);
  compilerOptions.paths = officialImports.paths;
  if (officialImports.usesSource) compilerOptions.customConditions = ["development"];

  const config: Record<string, unknown> = { compilerOptions, files: [entry] };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function typeRoots(cwd: string): string[] {
  const roots = [join(cwd, "node_modules/@types")];
  try {
    roots.push(dirname(dirname(fileURLToPath(import.meta.resolve("@types/node/package.json")))));
  } catch {
    // If node types are unavailable, let TypeScript report its normal diagnostic.
  }
  return [...new Set(roots)];
}
