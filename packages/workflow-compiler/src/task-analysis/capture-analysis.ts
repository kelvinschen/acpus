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
  const localBindings = checker ? undefined : collectLocalBindings(fn);
  const referenced = new Map<string, ts.Identifier[]>();
  collectReferences(fn, referenced);
  return [...referenced]
    .flatMap(([name, nodes]) => {
      const node = nodes.find(node => !isDeclaredInside(node, fn, declared, checker, localBindings) && !isRuntimeGlobalIdentifier(node, checker));
      return node ? [{ name, node }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isDeclaredInside(
  node: ts.Identifier,
  fn: ts.FunctionLikeDeclarationBase,
  declared: ReadonlySet<string>,
  checker?: ts.TypeChecker,
  localBindings?: ReadonlyMap<string, readonly ts.Node[]>,
): boolean {
  if (!checker) return localBindings?.get(node.text)?.some(scope => isDescendantOf(node, scope)) ?? false;
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return declared.has(node.text);
  return (symbol.declarations ?? []).some(declaration => isDescendantOf(declaration, fn));
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function isRuntimeGlobalIdentifier(node: ts.Identifier, checker?: ts.TypeChecker): boolean {
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

function collectLocalBindings(fn: ts.FunctionLikeDeclarationBase): Map<string, ts.Node[]> {
  const bindings = new Map<string, ts.Node[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node)) {
      addBindings(node.name, node.parent, bindings);
    } else if (ts.isVariableDeclaration(node)) {
      addBindings(node.name, variableScope(node), bindings);
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) addBinding(node.name, lexicalScope(node), bindings);
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      addBinding(node.name, node, bindings);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return bindings;
}

function variableScope(node: ts.VariableDeclaration): ts.Node {
  if (ts.isCatchClause(node.parent)) return node.parent.block;
  const declarationList = node.parent;
  if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
    return functionBodyScope(node);
  }
  return lexicalScope(node);
}

function functionBodyScope(node: ts.Node): ts.Node {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!isFunctionLikeDeclaration(current)) continue;
    return current.body && ts.isBlock(current.body) ? current.body : current;
  }
  return node.getSourceFile();
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclarationBase {
  return ts.isFunctionLike(node) && "body" in node;
}

function lexicalScope(node: ts.Node): ts.Node {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
      || ts.isCaseBlock(current)
      || ts.isBlock(current)
      || ts.isSourceFile(current)
    ) return current;
  }
  return node.getSourceFile();
}

function addBindings(name: ts.BindingName, scope: ts.Node, out: Map<string, ts.Node[]>): void {
  if (ts.isIdentifier(name)) {
    addBinding(name, scope, out);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindings(element.name, scope, out);
  }
}

function addBinding(name: ts.Identifier, scope: ts.Node, out: Map<string, ts.Node[]>): void {
  const scopes = out.get(name.text);
  if (scopes) scopes.push(scope);
  else out.set(name.text, [scope]);
}

function collectReferences(node: ts.Node, out: Map<string, ts.Identifier[]>): void {
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
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
    if (isValueReference(node)) addReference(node, out);
    return;
  }
  ts.forEachChild(node, child => collectReferences(child, out));
}

function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node)
    || ((ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent)
      || ts.isEnumDeclaration(parent)) && parent.name === node)
    || ((ts.isMethodDeclaration(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isEnumMember(parent)) && parent.name === node)
    || (ts.isLabeledStatement(parent) && parent.label === node)
    || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
    || ts.isMetaProperty(parent)
  ) return false;
  return true;
}

function addReference(node: ts.Identifier, out: Map<string, ts.Identifier[]>): void {
  const references = out.get(node.text);
  if (references) references.push(node);
  else out.set(node.text, [node]);
}

function isTypeScriptLibFile(fileName: string): boolean {
  return /(?:^|[/\\])typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(fileName);
}
