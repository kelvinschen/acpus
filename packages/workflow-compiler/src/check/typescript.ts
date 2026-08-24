import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { officialAuthoringTypeScriptPaths } from "@acpus/loader";
import type { DiagnosticIR } from "@acpus/core/ir";
import * as Result from "effect/Result";
import type { SourceFile } from "typescript/unstable/ast";
import { DiagnosticCategory, type Diagnostic, type Program } from "typescript/unstable/sync";
import { analyzeWorkflowTasksFromSourceFile } from "../task-analysis/index.js";
import { nativeFailure, withNativeProject, type TypeScriptNativeFailure } from "../typescript/native.js";
import { collectWorkflowAuthoringCandidates } from "./authoring-rules/index.js";
import { normalizeDiagnostics, type DiagnosticCandidate, type DiagnosticOrigin } from "./diagnostics.js";
import { officialAuthoringRoots } from "./official-types.js";
import { enrichTypeScriptDiagnostic, suppressCausalMissingLiftDiagnostics } from "./typescript-enrichment.js";
import { collectCheckedSourceGraph, type CheckedSourceFile } from "./source-capture.js";

export type TypeScriptCheck = {
  diagnostics: DiagnosticIR[];
  sourceFiles: CheckedSourceFile[];
  packageImportReferrers: string[];
};

export async function checkTypeScript(
  entry: string,
  cwd: string,
  scratchDir: string,
  source: string,
  options: { dependencyFallback?: boolean } = {},
): Promise<Result.Result<TypeScriptCheck, TypeScriptNativeFailure>> {
  let tsconfig: string;
  try {
    tsconfig = await writeTypecheckConfig(entry, cwd, scratchDir);
  } catch (cause) {
    return Result.fail(nativeFailure(cause));
  }
  return withNativeProject({
    configPath: tsconfig,
    cwd,
    sourcePath: entry,
    source,
    ...(options.dependencyFallback ? { dependencyRoot: cwd } : {}),
  }, ({ project, sourceFile }) => {
    const program = project.program;
    const roots = officialAuthoringRoots();
    const candidates: DiagnosticCandidate[] = [];
    const seen = new Set<string>();
    let sequence = 0;
    const append = (origin: DiagnosticOrigin, values: readonly Diagnostic[]): void => {
      for (const diagnostic of values) {
        const key = nativeDiagnosticKey(diagnostic);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(toCandidate(diagnostic, origin, sequence++, program, project, roots));
      }
    };
    append("config", program.getConfigFileParsingDiagnostics());
    append("program", program.getProgramDiagnostics());
    append("global", program.getGlobalDiagnostics());
    append("syntactic", program.getSyntacticDiagnostics());
    append("semantic", suppressCausalMissingLiftDiagnostics(program.getSemanticDiagnostics(), program));
    const semantic = { checker: project.checker, project, roots };
    const taskAnalysis = analyzeWorkflowTasksFromSourceFile(entry, sourceFile, semantic);
    for (const candidate of collectWorkflowAuthoringCandidates({ project, sourceFile, taskAnalysis, roots })) {
      candidates.push({ ...candidate, sequence: sequence++ });
    }
    const sourceGraph = collectCheckedSourceGraph(entry, program, project);
    for (const candidate of sourceGraph.diagnostics) {
      candidates.push({ ...candidate, sequence: sequence++ });
    }
    return {
      diagnostics: normalizeDiagnostics(candidates, entry),
      sourceFiles: sourceGraph.files,
      packageImportReferrers: sourceGraph.packageImportReferrers,
    };
  });
}

function nativeDiagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.category,
    diagnostic.code,
    diagnostic.fileName ?? "",
    diagnostic.pos,
    diagnostic.end,
    flattenDiagnosticMessage(diagnostic),
  ]);
}

function toCandidate(
  diagnostic: Diagnostic,
  origin: DiagnosticOrigin,
  sequence: number,
  program: Program,
  project: Parameters<typeof enrichTypeScriptDiagnostic>[2],
  roots: Parameters<typeof enrichTypeScriptDiagnostic>[3],
): DiagnosticCandidate {
  const result: DiagnosticIR = {
    code: `TS${diagnostic.code}`,
    severity: diagnostic.category === DiagnosticCategory.Warning ? "warning" : "error",
    message: flattenDiagnosticMessage(diagnostic),
  };
  const enrichment = enrichTypeScriptDiagnostic(diagnostic, program, project, roots);
  if (enrichment) result.hint = enrichment.hint;
  if (diagnostic.fileName && diagnostic.pos >= 0) {
    const file = program.getSourceFile(diagnostic.fileName);
    if (file) result.source = sourceLocation(file, diagnostic.pos);
  }
  return {
    diagnostic: result,
    origin,
    sequence,
    ...(diagnostic.fileName ? { file: diagnostic.fileName } : {}),
    ...(diagnostic.pos >= 0 ? { start: diagnostic.pos, end: Math.max(diagnostic.pos, diagnostic.end) } : {}),
    ...(enrichment?.ownership ? { ownership: enrichment.ownership } : {}),
    ...(enrichment?.ownershipStart === undefined ? {} : {
      ownershipStart: enrichment.ownershipStart,
      ownershipEnd: enrichment.ownershipEnd,
    }),
  };
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
