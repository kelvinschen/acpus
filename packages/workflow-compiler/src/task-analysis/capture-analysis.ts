import ts from "typescript";
import { collectDeclaredNames } from "./workflow-symbols.js";

const RUNTIME_GLOBALS = new Set<string>([
  ...Object.getOwnPropertyNames(globalThis),
  "arguments",
]);

export type FreeIdentifier = {
  name: string;
  node: ts.Identifier;
};

export function collectFreeIdentifiers(fn: ts.FunctionLikeDeclarationBase, checker?: ts.TypeChecker): string[] {
  return collectFreeIdentifierNodes(fn, checker).map(identifier => identifier.name);
}

export function collectFreeIdentifierNodes(fn: ts.FunctionLikeDeclarationBase, checker?: ts.TypeChecker): FreeIdentifier[] {
  const declared = new Set<string>();
  collectDeclaredNames(fn, declared);
  const referenced = new Map<string, ts.Identifier>();
  collectReferences(fn, referenced);
  return [...referenced]
    .filter(([name, node]) => !declared.has(name) && !isRuntimeGlobalIdentifier(node, checker))
    .map(([name, node]) => ({ name, node }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isRuntimeGlobalIdentifier(node: ts.Identifier, checker?: ts.TypeChecker): boolean {
  if (!checker) return RUNTIME_GLOBALS.has(node.text);
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return RUNTIME_GLOBALS.has(node.text);
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return false;
  if (declarations.every(declaration => isTypeScriptLibFile(declaration.getSourceFile().fileName))) return true;
  return RUNTIME_GLOBALS.has(node.text) && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
}

export function isRuntimeGlobalName(name: string): boolean {
  return RUNTIME_GLOBALS.has(name);
}

function collectReferences(node: ts.Node, out: Map<string, ts.Identifier>): void {
  if (ts.isTypeNode(node)) return;
  if (ts.isPropertyAccessExpression(node)) {
    collectReferences(node.expression, out);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) collectReferences(node.name.expression, out);
    collectReferences(node.initializer, out);
    return;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    addReference(node.name, out);
    return;
  }
  if (ts.isBindingElement(node)) {
    if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) collectReferences(node.propertyName.expression, out);
    collectReferences(node.name, out);
    if (node.initializer) collectReferences(node.initializer, out);
    return;
  }
  if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
    collectReferences(node.name, out);
    if (node.initializer) collectReferences(node.initializer, out);
    return;
  }
  if (ts.isIdentifier(node)) {
    addReference(node, out);
    return;
  }
  ts.forEachChild(node, child => collectReferences(child, out));
}

function addReference(node: ts.Identifier, out: Map<string, ts.Identifier>): void {
  if (!out.has(node.text)) out.set(node.text, node);
}

function isTypeScriptLibFile(fileName: string): boolean {
  return /(?:^|[/\\])typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(fileName);
}
