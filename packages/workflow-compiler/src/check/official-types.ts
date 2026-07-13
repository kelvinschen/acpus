import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { officialAuthoringEnvironment } from "@acpus/loader";
import * as ts from "typescript/unstable/ast";
import type { Checker, Project, Symbol, Type } from "typescript/unstable/sync";

export type OfficialAuthoringRoots = {
  core: string;
  expression: string;
};

export function officialAuthoringRoots(): OfficialAuthoringRoots {
  const environment = officialAuthoringEnvironment();
  return {
    core: canonicalPath(environment.imports["acpus/core"].packageRoot),
    expression: canonicalPath(environment.imports["acpus/expression"].packageRoot),
  };
}

export function isOfficialExpr(checker: Checker, project: Project, roots: OfficialAuthoringRoots, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type && typeHasOfficialProperty(checker, project, type, "__ir", roots.expression));
}

export function isOfficialNodeRef(checker: Checker, project: Project, roots: OfficialAuthoringRoots, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type && (
    typeHasOfficialAlias(project, type, "NodeRef", roots.core)
    || typeHasOfficialProperty(checker, project, type, "output", roots.core)
  ));
}

export function isOfficialStepFactory(checker: Checker, project: Project, roots: OfficialAuthoringRoots, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type && typeHasOfficialAlias(project, type, "StepFactory", roots.core));
}

export function isOfficialStepDeclaration(checker: Checker, project: Project, roots: OfficialAuthoringRoots, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type && (
    typeHasOfficialAlias(project, type, "StepDeclaration", roots.core)
    || typeHasOfficialProperty(checker, project, type, "task", roots.core)
  ));
}

export function isOfficialTaskDefine(checker: Checker, project: Project, roots: OfficialAuthoringRoots, node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!isPropertyNamed(callee, "define")) return false;
  const symbol = checker.getSymbolAtLocation(callee.name);
  return Boolean(symbol && symbolComesFrom(project, symbol, roots.core));
}

function isPropertyNamed(node: ts.Expression, name: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === name;
}

function typeHasOfficialAlias(project: Project, type: Type, name: string, root: string): boolean {
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes()?.some(member => typeHasOfficialAlias(project, member, name, root)) ?? false;
  }
  const alias = type.getAliasSymbol();
  return Boolean(alias?.name === name && symbolComesFrom(project, alias, root));
}

function typeHasOfficialProperty(checker: Checker, project: Project, type: Type, property: string, root: string): boolean {
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes()?.some(member => typeHasOfficialProperty(checker, project, member, property, root)) ?? false;
  }
  const symbol = checker.getPropertyOfType(type, property);
  return Boolean(symbol && symbolComesFrom(project, symbol, root));
}

function symbolComesFrom(project: Project, symbol: Symbol, root: string): boolean {
  return symbol.declarations.some(handle => {
    const declaration = handle.resolve(project);
    return Boolean(declaration && pathIsInside(canonicalPath(declaration.getSourceFile().fileName), root));
  });
}

function pathIsInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
