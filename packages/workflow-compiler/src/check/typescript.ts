import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { officialAuthoringTypeScriptPaths } from "@acpus/loader";
import type { DiagnosticIR } from "@acpus/core/ir";
import { err, type Result } from "neverthrow";
import type { SourceFile } from "typescript/unstable/ast";
import { DiagnosticCategory, type Diagnostic, type Program } from "typescript/unstable/sync";
import { analyzeWorkflowTasksFromSourceFile } from "../task-analysis/index.js";
import { nativeFailure, withNativeProject, type TypeScriptNativeFailure } from "../typescript/native.js";
import { collectWorkflowAuthoringCandidates } from "./authoring-rules/index.js";
import type { DiagnosticCandidate, DiagnosticOrigin } from "./diagnostics.js";
import { officialAuthoringRoots } from "./official-types.js";
import { enrichTypeScriptDiagnostic, suppressCausalMissingLiftDiagnostics } from "./typescript-enrichment.js";

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
    return { diagnostics: normalizeDiagnostics(candidates, entry) };
  });
}

export function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = nativeDiagnosticKey(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
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

export function normalizeDiagnostics(candidates: readonly DiagnosticCandidate[], entry: string): DiagnosticIR[] {
  const ownedByTypeScript = candidates.filter(candidate => candidate.origin === "semantic" && candidate.ownership);
  const singleOwned = candidates.filter(candidate => {
    if (candidate.origin !== "authoring" || !candidate.ownership) return true;
    return !ownedByTypeScript.some(native => native.ownership === candidate.ownership
      && sameFile(native.file, candidate.file)
      && rangesOverlap(ownershipRange(native), ownershipRange(candidate)));
  });
  const broad = new Set(singleOwned.filter(candidate => candidate.origin === "semantic"
    && candidate.file
    && candidate.start !== undefined
    && candidate.end !== undefined
    && candidate.end > candidate.start
    && singleOwned.some(other => other !== candidate
      && sameFile(candidate.file, other.file)
      && containsRange(candidate, other))));
  const sorted = [...singleOwned].sort((left, right) => compareCandidates(left, right, entry, broad));
  const seen = new Set<string>();
  return sorted.flatMap(candidate => {
    const key = visibleDiagnosticKey(candidate.diagnostic);
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate.diagnostic];
  });
}

function compareCandidates(
  left: DiagnosticCandidate,
  right: DiagnosticCandidate,
  entry: string,
  broad: ReadonlySet<DiagnosticCandidate>,
): number {
  const leftGroup = diagnosticGroup(left, entry);
  const rightGroup = diagnosticGroup(right, entry);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftGroup === 5) {
    const fileOrder = (left.file ?? "").localeCompare(right.file ?? "");
    if (fileOrder !== 0) return fileOrder;
  }
  if (sameFile(left.file, right.file)) {
    if (broad.has(left) && containsRange(left, right)) return 1;
    if (broad.has(right) && containsRange(right, left)) return -1;
  }
  return sourceStart(left) - sourceStart(right) || left.sequence - right.sequence;
}

function diagnosticGroup(candidate: DiagnosticCandidate, entry: string): number {
  switch (candidate.origin) {
    case "config": return 0;
    case "program": return 1;
    case "global": return 2;
    case "syntactic": return 3;
    case "authoring": return 4;
    case "semantic": return sameFile(candidate.file, entry) ? 4 : 5;
  }
}

function sourceStart(candidate: DiagnosticCandidate): number {
  if (candidate.start !== undefined) return candidate.start;
  const source = candidate.diagnostic.source;
  return source?.line === undefined ? Number.MAX_SAFE_INTEGER : source.line * 1_000_000 + (source.column ?? 0);
}

function ownershipRange(candidate: DiagnosticCandidate): { start?: number; end?: number } {
  const start = candidate.ownershipStart ?? candidate.start;
  const end = candidate.ownershipEnd ?? candidate.end;
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function rangesOverlap(left: { start?: number; end?: number }, right: { start?: number; end?: number }): boolean {
  if (left.start === undefined || left.end === undefined || right.start === undefined || right.end === undefined) return false;
  return left.start <= right.end && right.start <= left.end;
}

function containsRange(container: DiagnosticCandidate, contained: DiagnosticCandidate): boolean {
  if (container.start === undefined || container.end === undefined || contained.start === undefined || contained.end === undefined) return false;
  return container.start <= contained.start
    && container.end >= contained.end
    && (container.start < contained.start || container.end > contained.end);
}

function sameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  return resolve(left) === resolve(right);
}

function visibleDiagnosticKey(diagnostic: DiagnosticIR): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.path,
    diagnostic.source?.file,
    diagnostic.source?.line,
    diagnostic.source?.column,
    diagnostic.hint,
  ]);
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
