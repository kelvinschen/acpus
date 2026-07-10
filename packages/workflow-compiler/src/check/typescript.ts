import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { officialAuthoringTypeScriptPaths } from "@acpus/loader";
import type { DiagnosticIR } from "@acpus/core/ir";
import ts from "typescript";

export type TypeScriptCheck = {
  diagnostics: DiagnosticIR[];
  program?: ts.Program;
  sourceFile?: ts.SourceFile;
};

export async function checkTypeScript(entry: string, cwd: string, scratchDir: string): Promise<TypeScriptCheck> {
  const tsconfig = await writeTypecheckConfig(entry, cwd, scratchDir);
  const config = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (config.error) return { diagnostics: [toDiagnosticIR(config.error)] };

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfig), undefined, tsconfig);
  const programOptions: ts.CreateProgramOptions = {
    rootNames: parsed.fileNames,
    options: parsed.options,
  };
  if (parsed.projectReferences) programOptions.projectReferences = parsed.projectReferences;
  const program = ts.createProgram(programOptions);
  const diagnostics = [
    ...parsed.errors,
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].map(toDiagnosticIR);

  const result: TypeScriptCheck = { diagnostics, program };
  const sourceFile = program.getSourceFile(entry);
  if (sourceFile) result.sourceFile = sourceFile;
  return result;
}

function toDiagnosticIR(diagnostic: ts.Diagnostic): DiagnosticIR {
  const result: DiagnosticIR = {
    code: `TS${diagnostic.code}`,
    severity: diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  if (diagnostic.file && diagnostic.start !== undefined) result.source = sourceLocation(diagnostic.file, diagnostic.start);
  return result;
}

function sourceLocation(file: ts.SourceFile, start: number): NonNullable<DiagnosticIR["source"]> {
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
