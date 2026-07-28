import { dirname, extname, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import type { Program, Project } from "typescript/unstable/sync";
import type { DiagnosticCandidate } from "./diagnostics.js";

export type CheckedSourceFile = {
  path: string;
  content: string;
};

export type CheckedSourceGraph = {
  files: CheckedSourceFile[];
  diagnostics: DiagnosticCandidate[];
  packageImportReferrers: string[];
};

export function collectCheckedSourceGraph(
  entry: string,
  program: Program,
  project: Project,
): CheckedSourceGraph {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const fileName of program.getSourceFileNames()) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) sourceFiles.set(resolve(sourceFile.fileName), sourceFile);
  }

  const files: CheckedSourceFile[] = [];
  const diagnostics: DiagnosticCandidate[] = [];
  const packageImportReferrers = new Set<string>();
  const pending = [resolve(entry)];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const sourceFile = sourceFiles.get(path);
    if (!sourceFile) continue;
    files.push({ path: sourceFile.fileName, content: sourceFile.text });
    if (sourceFile.isDeclarationFile) continue;
    for (const edge of moduleEdges(sourceFile, project)) {
      const issue = unsupportedEdge(edge);
      if (issue) diagnostics.push(sourceDiagnostic(edge.node, issue));
      if (!edge.specifier || !isStaticLocalSpecifier(edge.specifier) || edge.kind === "require") continue;
      const target = resolveModuleSource(edge.node, edge.specifier, sourceFile, sourceFiles, project);
      if (!target) continue;
      if (edge.specifier.startsWith("#") && program.isSourceFileFromExternalLibrary(target)) continue;
      if (edge.specifier.startsWith("#")) packageImportReferrers.add(resolve(sourceFile.fileName));
      if (!isSourceGraphTypeScript(target.fileName)) {
        diagnostics.push(sourceDiagnostic(
          edge.node,
          `Static local module '${edge.specifier}' resolves to an unsupported source file; it is outside the tracked source graph.`,
        ));
        continue;
      }
      if (target.isDeclarationFile) {
        diagnostics.push(sourceDiagnostic(
          edge.node,
          `Static local module '${edge.specifier}' resolves only to a declaration file; its implementation is outside the tracked source graph.`,
        ));
        pending.push(resolve(target.fileName));
        continue;
      }
      pending.push(resolve(target.fileName));
    }
  }

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    files,
    diagnostics,
    packageImportReferrers: [...packageImportReferrers].sort(),
  };
}

type ModuleEdge = {
  kind: "static" | "dynamic" | "require" | "create-require";
  node: ts.Node;
  specifier?: string;
};

function moduleEdges(sourceFile: ts.SourceFile, project: Project): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        edges.push({ kind: "static", node: node.moduleSpecifier, specifier: node.moduleSpecifier.text });
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      edges.push({
        kind: "require",
        node: node.moduleReference.expression,
        specifier: node.moduleReference.expression.text,
      });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
          edges.push({ kind: "dynamic", node: argument, specifier: argument.text });
        } else {
          edges.push({ kind: "dynamic", node: argument ?? node });
        }
      } else if (isCreateRequire(node.expression, project)) {
        edges.push({ kind: "create-require", node });
      } else if (ts.isIdentifier(node.expression) && isRuntimeRequire(node.expression, project)) {
        const argument = node.arguments[0];
        edges.push({
          kind: "require",
          node: argument ?? node,
          ...(argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
            ? { specifier: argument.text }
            : {}),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return edges;
}

function isCreateRequire(node: ts.Expression, project: Project): boolean {
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return Boolean(symbol?.declarations.some(handle => {
      const declaration = handle.resolve(project);
      return Boolean(declaration
        && ts.isImportSpecifier(declaration)
        && (declaration.propertyName ?? declaration.name).text === "createRequire"
        && isNodeModuleImport(declaration.parent.parent.parent));
    }));
  }
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "createRequire") return false;
  const receiver = node.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const symbol = project.checker.getSymbolAtLocation(receiver);
  return Boolean(symbol?.declarations.some(handle => {
    const declaration = handle.resolve(project);
    return Boolean(declaration
      && ts.isNamespaceImport(declaration)
      && isNodeModuleImport(declaration.parent.parent));
  }));
}

function isRuntimeRequire(node: ts.Identifier, project: Project): boolean {
  if (node.text !== "require") return false;
  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol || symbol.declarations.length === 0) return true;
  return symbol.declarations.every(handle => handle.resolve(project)?.getSourceFile().isDeclarationFile === true);
}

function isNodeModuleImport(node: ts.Node): boolean {
  return ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier)
    && (node.moduleSpecifier.text === "node:module" || node.moduleSpecifier.text === "module");
}

function unsupportedEdge(edge: ModuleEdge): string | undefined {
  if (edge.kind === "create-require") {
    return "createRequire module loading is outside the statically tracked workflow source graph.";
  }
  if (edge.specifier === undefined) {
    return `${edge.kind === "dynamic" ? "Dynamic import" : "require"} with a non-literal specifier is outside the statically tracked workflow source graph.`;
  }
  if (edge.kind === "require" && isStaticLocalSpecifier(edge.specifier)) {
    return `Relative require '${edge.specifier}' is outside the statically tracked workflow source graph.`;
  }
  if (isAbsoluteModuleSpecifier(edge.specifier)) {
    return `Absolute module load '${edge.specifier}' is outside the statically tracked workflow source graph.`;
  }
  return undefined;
}

function resolveModuleSource(
  node: ts.Node,
  specifier: string,
  referrer: ts.SourceFile,
  sourceFiles: ReadonlyMap<string, ts.SourceFile>,
  project: Project,
): ts.SourceFile | undefined {
  const symbol = project.checker.getSymbolAtLocation(node);
  for (const handle of symbol?.declarations ?? []) {
    const declaration = handle.resolve(project);
    const sourceFile = declaration?.getSourceFile();
    if (sourceFile && resolve(sourceFile.fileName) !== resolve(referrer.fileName)) return sourceFile;
  }
  if (!specifier.startsWith(".")) return undefined;
  const requested = resolve(dirname(referrer.fileName), specifier);
  for (const sourceFile of sourceFiles.values()) {
    if (modulePathMatches(requested, sourceFile.fileName)) return sourceFile;
  }
  return undefined;
}

function modulePathMatches(requested: string, candidate: string): boolean {
  const target = resolve(candidate);
  if (target === requested) return true;
  const extension = extname(requested).toLowerCase();
  if (extension === ".js") return [".ts", ".tsx", ".d.ts"].some(value => `${requested.slice(0, -3)}${value}` === target);
  if (extension === ".mjs") return [".mts", ".d.mts"].some(value => `${requested.slice(0, -4)}${value}` === target);
  if (extension === ".cjs") return [".cts", ".d.cts"].some(value => `${requested.slice(0, -4)}${value}` === target);
  if (extension) return false;
  return [".ts", ".tsx", ".mts", ".cts", ".d.ts"]
    .flatMap(value => [`${requested}${value}`, resolve(requested, `index${value}`)])
    .includes(target);
}

function isStaticLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("#");
}

function isSourceGraphTypeScript(path: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/i.test(path);
}

function isAbsoluteModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("/")
    || specifier.startsWith("file:")
    || /^[A-Za-z]:[\\/]/.test(specifier)
    || specifier.startsWith("\\\\");
}

function sourceDiagnostic(node: ts.Node, message: string): DiagnosticCandidate {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    diagnostic: {
      code: "SC001",
      severity: "warning",
      message,
      hint: "Use a static relative import, or provide every possible target explicitly through a files source input.",
      source: {
        file: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
      },
    },
    origin: "source",
    file: sourceFile.fileName,
    start,
    end: node.end,
    sequence: 0,
  };
}
