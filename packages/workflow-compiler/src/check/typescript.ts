import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  const baseConfig = await findUp("tsconfig.json", dirname(entry));
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
    typeRoots: [join(cwd, "node_modules/@types")],
    rootDir: commonPath([cwd, dirname(entry)]),
    tsBuildInfoFile: join(scratchDir, ".tsbuildinfo"),
  };

  const coreSourceDir = join(cwd, "packages/core/src");
  const coreSource = join(coreSourceDir, "index.ts");
  if (await exists(coreSource)) {
    compilerOptions.customConditions = ["development"];
    compilerOptions.paths = {
      "@acpus/core": [configRelative(scratchDir, coreSource)],
      "@acpus/core/*": [configRelative(scratchDir, join(coreSourceDir, "*.ts"))],
    };
  }

  const config: Record<string, unknown> = { compilerOptions, files: [entry] };
  if (baseConfig) config.extends = configRelative(scratchDir, baseConfig);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function findUp(name: string, start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, name);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commonPath(paths: string[]): string {
  const [first, ...rest] = paths.map(path => resolve(path).split(/[\\/]+/));
  const firstPath = paths[0] ?? process.cwd();
  if (!first) return process.cwd();
  let end = first.length;
  for (const parts of rest) {
    end = Math.min(end, parts.length);
    for (let i = 0; i < end; i += 1) {
      if (parts[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  const prefix = first.slice(0, end).join("/");
  return isAbsolute(firstPath) ? `/${prefix.replace(/^\/+/, "")}` : prefix;
}

function configRelative(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}
