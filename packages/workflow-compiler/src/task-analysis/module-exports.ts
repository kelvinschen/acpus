import { readFileSync, statSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { isExported, isTaskDefineCall, parseSourceFile, taskFactoryLocalName } from "./ast.js";
import type { TaskAuthoringIssue } from "./types.js";

type ExportVerdict = { ok: true } | { ok: false; issue: TaskAuthoringIssue };
type ExportTarget = { ok: true; expression: ts.Expression } | { ok: false; issue: TaskAuthoringIssue };

export async function resolveImportFile(specifier: string, fromFile: string): Promise<string | undefined> {
  for (const candidate of importCandidates(specifier, fromFile)) {
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

export function resolveImportFileSync(specifier: string, fromFile: string): string | undefined {
  for (const candidate of importCandidates(specifier, fromFile)) {
    if (isFileSync(candidate)) return candidate;
  }
  return undefined;
}

function importCandidates(specifier: string, fromFile: string): string[] {
  const base = resolve(dirname(fromFile), specifier);
  const candidates: string[] = [];
  const tsExtensions = [".ts", ".mts", ".cts", ".tsx"];
  const jsMatch = base.match(/\.(js|mjs|cjs)$/);
  if (jsMatch) {
    for (const extension of tsExtensions) candidates.push(base.replace(/\.(js|mjs|cjs)$/, extension));
  }
  candidates.push(base);
  for (const extension of [...tsExtensions, ".js", ".mjs", ".cjs"]) candidates.push(`${base}${extension}`);
  for (const extension of [...tsExtensions, ".js", ".mjs", ".cjs"]) candidates.push(`${base}/index${extension}`);
  return candidates;
}

export async function verifyTaskModuleExport(file: string, importedName: string): Promise<ExportVerdict> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    void error;
    return { ok: false, issue: { kind: "unsupported-task-import", name: importedName, reason: "read-failed" } };
  }
  return verifyTaskModuleSource(file, source, importedName);
}

export function verifyTaskModuleExportSync(file: string, importedName: string): ExportVerdict {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    void error;
    return { ok: false, issue: { kind: "unsupported-task-import", name: importedName, reason: "read-failed" } };
  }
  return verifyTaskModuleSource(file, source, importedName);
}

function verifyTaskModuleSource(file: string, source: string, importedName: string): ExportVerdict {
  const sourceFile = parseSourceFile(file, source);
  const taskFactory = taskFactoryLocalName(sourceFile);
  const locals = collectLocalInitializers(sourceFile);
  const target = importedName === "default"
    ? resolveDefaultExport(sourceFile)
    : resolveNamedExport(sourceFile, importedName);
  if (!target.ok) return target;
  const initializer = ts.isIdentifier(target.expression)
    ? locals.get(target.expression.text)
    : target.expression;
  if (!initializer || !isTaskDefineCall(initializer, taskFactory)) {
    return { ok: false, issue: { kind: "invalid-reusable-task-export", importedName, file, reason: "not-task-define" } };
  }
  return { ok: true };
}

function resolveDefaultExport(sourceFile: ts.SourceFile): ExportTarget {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return { ok: true, expression: statement.expression };
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      return barrel(statement.moduleSpecifier);
    }
  }
  return { ok: false, issue: { kind: "invalid-reusable-task-export", importedName: "default", reason: "missing-default" } };
}

function resolveNamedExport(sourceFile: ts.SourceFile, name: string): ExportTarget {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          return { ok: true, expression: declaration.initializer };
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        if (statement.moduleSpecifier) return barrel(statement.moduleSpecifier);
        const local = (element.propertyName ?? element.name).text;
        return { ok: true, expression: ts.factory.createIdentifier(local) };
      }
    }
  }
  return { ok: false, issue: { kind: "invalid-reusable-task-export", importedName: name, reason: "missing-named" } };
}

function barrel(moduleSpecifier: ts.Expression): ExportTarget {
  const specifier = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "<module>";
  return { ok: false, issue: { kind: "unsupported-task-import", name: "<re-export>", specifier, reason: "barrel" } };
}

function collectLocalInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
