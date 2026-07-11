import * as ts from "typescript/unstable/ast";
import { isConstVariableStatement, isExported } from "./ast.js";
import type { ImportBinding, WorkflowTaskExport } from "./types.js";

export function collectImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { specifier, importedName: "default" });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, { specifier, importedName: (element.propertyName ?? element.name).text });
      }
    }
  }
  return bindings;
}

export function collectLocalValueNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  collectDeclaredNames(sourceFile, names);
  return names;
}

export function collectDeclaredNames(node: ts.Node, out: Set<string>): void {
  if (ts.isParameterDeclaration(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    if (node.name) addBindingName(node.name, out);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    out.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    addBindingName(node.variableDeclaration.name, out);
  }
  node.forEachChild(child => collectDeclaredNames(child, out));
}

export function hasInnerBinding(identifier: ts.Identifier): boolean {
  const sourceFile = identifier.getSourceFile();
  const name = identifier.text;
  const position = identifier.getStart(sourceFile);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    for (const binding of bindingNames(node)) {
      if (binding.text !== name || binding === identifier || isTopLevelBinding(binding, sourceFile)) continue;
      const scope = bindingScope(binding, sourceFile);
      if (scope.getStart(sourceFile) <= position && position < scope.end) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

export function collectWorkflowTaskExports(sourceFile: ts.SourceFile): Map<string, WorkflowTaskExport> {
  const initializers = collectTopLevelInitializers(sourceFile);
  const exportedNames = collectLocalNamedExports(sourceFile);
  const exports = new Map<string, WorkflowTaskExport>();
  for (const [localName, exportName] of exportedNames) {
    const exportInfo: WorkflowTaskExport = { exportName };
    const initializer = initializers.get(localName);
    if (initializer) exportInfo.initializer = initializer;
    exports.set(localName, exportInfo);
  }
  return exports;
}

function collectTopLevelInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !isConstVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        initializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return initializers;
}

function collectLocalNamedExports(sourceFile: ts.SourceFile): Map<string, string> {
  const exports = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement) && isConstVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exports.set(declaration.name.text, declaration.name.text);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const localName = (element.propertyName ?? element.name).text;
      const exportName = element.name.text;
      if (localName === exportName) exports.set(localName, exportName);
    }
  }
  return exports;
}

function bindingNames(node: ts.Node): ts.Identifier[] {
  if (ts.isParameterDeclaration(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    return node.name ? identifiersFromBindingName(node.name) : [];
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return [node.name];
  if (ts.isCatchClause(node) && node.variableDeclaration) return identifiersFromBindingName(node.variableDeclaration.name);
  return [];
}

function identifiersFromBindingName(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap(element => ts.isBindingElement(element) && element.name ? identifiersFromBindingName(element.name) : []);
}

function addBindingName(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element) && element.name) addBindingName(element.name, out);
  }
}

function isTopLevelBinding(identifier: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  const declaration = declarationNode(identifier);
  if (!declaration) return false;
  if ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) && declaration.parent === sourceFile) return true;
  if (ts.isVariableDeclaration(declaration)) {
    return ts.isVariableDeclarationList(declaration.parent)
      && ts.isVariableStatement(declaration.parent.parent)
      && declaration.parent.parent.parent === sourceFile;
  }
  return false;
}

function declarationNode(identifier: ts.Identifier): ts.Node | undefined {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    if (ts.isParameterDeclaration(current) || ts.isVariableDeclaration(current) || ts.isBindingElement(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isCatchClause(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function bindingScope(identifier: ts.Identifier, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = declarationNode(identifier)?.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isFunctionLikeDeclaration(current)) return current;
    current = current.parent;
  }
  return sourceFile;
}
