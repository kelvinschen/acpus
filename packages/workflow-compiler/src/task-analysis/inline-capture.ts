import ts from "typescript";
import { collectDeclaredNames } from "./workflow-symbols.js";

const GLOBALS = new Set<string>([
  ...Object.getOwnPropertyNames(globalThis),
  "arguments",
]);

export function collectFreeIdentifiers(fn: ts.FunctionLikeDeclarationBase): string[] {
  const declared = new Set<string>();
  collectDeclaredNames(fn, declared);
  const referenced = new Set<string>();
  collectReferences(fn, referenced);
  return [...referenced].filter(name => !declared.has(name) && !GLOBALS.has(name)).sort();
}

function collectReferences(node: ts.Node, out: Set<string>): void {
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
    out.add(node.name.text);
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
    out.add(node.text);
    return;
  }
  ts.forEachChild(node, child => collectReferences(child, out));
}
