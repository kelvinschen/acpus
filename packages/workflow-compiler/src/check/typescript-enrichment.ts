import * as ts from "typescript/unstable/ast";
import type { Diagnostic, Program, Project, Type } from "typescript/unstable/sync";
import type { AuthoringOwnership } from "./diagnostics.js";
import {
  isOfficialExpr,
  isOfficialNodeRef,
  isOfficialStepDeclaration,
  isOfficialTaskDefine,
  type OfficialAuthoringRoots,
} from "./official-types.js";

export type TypeScriptEnrichment = {
  hint: string;
  ownership?: AuthoringOwnership;
  ownershipStart?: number;
  ownershipEnd?: number;
};

const ARITHMETIC_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const RELATIONAL_HELPERS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.LessThanToken, "lt"],
  [ts.SyntaxKind.LessThanEqualsToken, "lte"],
  [ts.SyntaxKind.GreaterThanToken, "gt"],
  [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
]);

const ARRAY_MEMBERS = new Set([
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "flat", "flatMap", "forEach", "includes",
  "indexOf", "join", "keys", "lastIndexOf", "length", "map", "reduce", "reduceRight", "reverse", "slice", "some",
  "sort", "toReversed", "toSorted", "toSpliced", "values", "with",
]);

export function enrichTypeScriptDiagnostic(
  diagnostic: Diagnostic,
  program: Program,
  project: Project,
  roots: OfficialAuthoringRoots,
): TypeScriptEnrichment | undefined {
  if (!diagnostic.fileName || diagnostic.pos < 0) return undefined;
  const sourceFile = program.getSourceFile(diagnostic.fileName);
  if (!sourceFile) return undefined;
  const node = nodeAtSpan(sourceFile, diagnostic.pos, diagnostic.end > diagnostic.pos ? diagnostic.end : diagnostic.pos + 1);
  const checker = project.checker;

  if (diagnostic.code === 2362 || diagnostic.code === 2363 || diagnostic.code === 2365 || diagnostic.code === 2367) {
    const binary = ancestor(node, ts.isBinaryExpression);
    if (binary && (isOfficialExpr(checker, project, roots, binary.left) || isOfficialExpr(checker, project, roots, binary.right))) {
      if (EQUALITY_OPERATORS.has(binary.operatorToken.kind)) {
        const helper = binary.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
          || binary.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? "ne" : "eq";
        return owned(binary, { hint: `Use ${helper}(left, right) for this comparison over runtime values.`, ownership: "expr-equality" });
      }
      const relational = RELATIONAL_HELPERS.get(binary.operatorToken.kind);
      if (relational) return owned(binary, { hint: `Use ${relational}(left, right) for this comparison over runtime values.`, ownership: "expr-relational" });
      if (ARITHMETIC_OPERATORS.has(binary.operatorToken.kind)) {
        return { hint: "Use lift with every runtime dependency, for example lift(value, value => value + 1)." };
      }
    }
  }

  if (diagnostic.code === 2678) {
    const clause = ancestor(node, ts.isCaseClause);
    const statement = clause && ts.isCaseBlock(clause.parent) && ts.isSwitchStatement(clause.parent.parent)
      ? clause.parent.parent
      : undefined;
    if (statement && isOfficialExpr(checker, project, roots, statement.expression)) {
      return owned(statement, {
        hint: "Use step(\"id\").switch({ cases, default }) for graph control, with eq/ne or other predicates in each case.",
        ownership: "expr-switch",
      });
    }
  }

  if (diagnostic.code === 2339) {
    const access = ancestor(node, ts.isPropertyAccessExpression);
    if (access && isOfficialNodeRef(checker, project, roots, access.expression)) {
      const suffix = isCalledAccess(access) ? "()" : "";
      return { hint: `Read the node result through .output before accessing '${access.name.text}', for example node.output.${access.name.text}${suffix}.` };
    }
    if (access && isOfficialExpr(checker, project, roots, access.expression)) {
      const usage = isCalledAccess(access) ? `${access.name.text}(...)` : access.name.text;
      return ARRAY_MEMBERS.has(access.name.text)
        ? { hint: `Expr arrays are runtime values; use lift(items, items => items.${usage}) for this operation.` }
        : { hint: `This field is not common to every runtime branch; use lift(value, value => /* narrow */ value.${access.name.text}) to narrow before reading it.` };
    }
  }

  if (diagnostic.code === 2345) {
    const callback = enclosingFunction(node);
    if (callback && isGraphCallback(callback, checker, project, roots)) {
      if (callbackReturnsNodeRef(callback, checker, project, roots)) {
        return { hint: "Return node.output from graph callbacks; do not return a NodeRef, even when nested." };
      }
      if (callbackReturnsNonDurable(callback, checker)) {
        return { hint: "Return JSON-compatible WorkflowData from graph callbacks; convert Date and other class instances to strings or plain objects." };
      }
    }
  }

  if (diagnostic.code === 2769) {
    const call = ancestor(node, ts.isCallExpression);
    const callback = call && callbackForWorkflowDataCall(call);
    if (call && callback && (isOfficialLiftCall(call, project) || isOfficialInlineTaskCall(call, checker, project, roots))) {
      const kind = invalidReturnKind(callback, checker);
      if (kind) {
        return { hint: kind === "undefined"
          ? "Return null for absence; lift and Task callbacks must return JSON-compatible WorkflowData, not undefined."
          : "Return JSON-compatible WorkflowData; convert Date and other class instances to strings or plain objects before returning them." };
      }
    }
  }
}

function isCalledAccess(access: ts.PropertyAccessExpression): boolean {
  return Boolean(access.parent && ts.isCallExpression(access.parent) && access.parent.expression === access);
}

function owned(node: ts.Node, enrichment: TypeScriptEnrichment): TypeScriptEnrichment {
  return { ...enrichment, ownershipStart: node.getStart(node.getSourceFile()), ownershipEnd: node.end };
}

function nodeAtSpan(sourceFile: ts.SourceFile, start: number, end: number): ts.Node {
  let best: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (node.pos > start || node.end < end) return;
    best = node;
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return best;
}

function ancestor<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T): T | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (predicate(current)) return current;
  }
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  return ancestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLikeDeclaration(candidate));
}

function callbackReturnsNodeRef(
  callback: ts.FunctionLikeDeclaration,
  checker: Project["checker"],
  project: Project,
  roots: OfficialAuthoringRoots,
): boolean {
  return returnExpressions(callback).some(expression => expressionContainsNodeRef(expression, checker, project, roots));
}

function expressionContainsNodeRef(
  expression: ts.Expression,
  checker: Project["checker"],
  project: Project,
  roots: OfficialAuthoringRoots,
): boolean {
  if (isOfficialNodeRef(checker, project, roots, expression)) return true;
  if (ts.isParenthesizedExpression(expression) || ts.isAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return expressionContainsNodeRef(expression.expression, checker, project, roots);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return expressionContainsNodeRef(property.initializer, checker, project, roots);
      if (ts.isShorthandPropertyAssignment(property)) return isOfficialNodeRef(checker, project, roots, property.name);
      if (ts.isSpreadAssignment(property)) return expressionContainsNodeRef(property.expression, checker, project, roots);
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(element => ts.isExpression(element) && expressionContainsNodeRef(element, checker, project, roots));
  }
  return false;
}

function callbackReturnsNonDurable(callback: ts.FunctionLikeDeclaration, checker: Project["checker"]): boolean {
  return returnExpressions(callback).some(expression => expressionContainsDate(expression, checker));
}

function expressionContainsDate(expression: ts.Expression, checker: Project["checker"]): boolean {
  const type = checker.getTypeAtLocation(expression);
  if (type && containsDate(type)) return true;
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return expressionContainsDate(property.initializer, checker);
      if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) return expressionContainsDate(property.name, checker);
      if (ts.isSpreadAssignment(property)) return expressionContainsDate(property.expression, checker);
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(element => ts.isExpression(element) && expressionContainsDate(element, checker));
  }
  return false;
}

function returnExpressions(callback: ts.FunctionLikeDeclaration): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  if (callback.body && ts.isExpression(callback.body)) expressions.push(callback.body);
  if (callback.body && ts.isBlock(callback.body)) {
    const collect = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
      else if (node !== callback.body && ts.isFunctionLikeDeclaration(node)) return;
      else node.forEachChild(collect);
    };
    collect(callback.body);
  }
  return expressions;
}

function isGraphCallback(
  callback: ts.FunctionLikeDeclaration,
  checker: Project["checker"],
  project: Project,
  roots: OfficialAuthoringRoots,
): boolean {
  const directCall = callback.parent && ts.isCallExpression(callback.parent) && callback.parent.arguments.includes(callback as ts.Expression)
    ? callback.parent
    : undefined;
  if (directCall && ts.isPropertyAccessExpression(directCall.expression) && directCall.expression.name.text === "build") return true;
  const member = ts.isMethodDeclaration(callback) ? callback : callback.parent;
  const object = member && (ts.isMethodDeclaration(member) || ts.isPropertyAssignment(member)) ? member.parent : undefined;
  const call = object && ts.isObjectLiteralExpression(object) && object.parent && ts.isCallExpression(object.parent) ? object.parent : undefined;
  return Boolean(call
    && ts.isPropertyAccessExpression(call.expression)
    && isOfficialStepDeclaration(checker, project, roots, call.expression.expression));
}

function isOfficialLiftCall(call: ts.CallExpression, project: Project): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) return isNamedLiftImport(callee, project);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "lift") {
    return isExpressionNamespace(callee.expression, project);
  }
  if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
    const key = unwrapTransparentExpression(callee.argumentExpression);
    return ts.isStringLiteral(key) && key.text === "lift" && isExpressionNamespace(callee.expression, project);
  }
  return false;
}

function isNamedLiftImport(node: ts.Identifier, project: Project): boolean {
  const symbol = project.checker.getSymbolAtLocation(node);
  return Boolean(symbol?.declarations.some(handle => {
    const declaration = handle.resolve(project);
    return Boolean(declaration
      && ts.isImportSpecifier(declaration)
      && (declaration.propertyName ?? declaration.name).text === "lift"
      && isExpressionFacadeImport(declaration.parent.parent.parent));
  }));
}

function isExpressionNamespace(node: ts.Expression, project: Project): boolean {
  const receiver = unwrapTransparentExpression(node);
  if (!ts.isIdentifier(receiver)) return false;
  const symbol = project.checker.getSymbolAtLocation(receiver);
  return Boolean(symbol?.declarations.some(handle => {
    const declaration = handle.resolve(project);
    return Boolean(declaration && ts.isNamespaceImport(declaration) && isExpressionFacadeImport(declaration.parent.parent));
  }));
}

function isExpressionFacadeImport(node: ts.Node): boolean {
  return ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === "acpus/expression";
}

function unwrapTransparentExpression(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node)
    || ts.isAssertionExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)
  ) node = node.expression;
  return node;
}

function isOfficialInlineTaskCall(
  call: ts.CallExpression,
  checker: Project["checker"],
  project: Project,
  roots: OfficialAuthoringRoots,
): boolean {
  if (isOfficialTaskDefine(checker, project, roots, call)) return true;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "task") return false;
  return isOfficialStepDeclaration(checker, project, roots, call.expression.expression);
}

function callbackForWorkflowDataCall(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  const direct = call.arguments.find((argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
    ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  if (direct) return direct;
  const spec = call.arguments[0];
  if (!spec || !ts.isObjectLiteralExpression(spec)) return undefined;
  for (const property of spec.properties) {
    if (ts.isPropertyAssignment(property)
      && propertyName(property.name) === "exec"
      && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) return property.initializer;
    if (ts.isMethodDeclaration(property) && propertyName(property.name) === "exec") return property;
  }
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function invalidReturnKind(callback: ts.FunctionLikeDeclaration, checker: Project["checker"]): "undefined" | "non-durable" | undefined {
  const expressions: ts.Expression[] = [];
  if (callback.body && ts.isExpression(callback.body)) expressions.push(callback.body);
  if (callback.body && ts.isBlock(callback.body)) {
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
      else node.forEachChild(visit);
    };
    visit(callback.body);
  }
  for (const expression of expressions) {
    const type = checker.getTypeAtLocation(expression);
    if (!type) continue;
    const rendered = checker.typeToString(type, expression);
    if (rendered === "undefined" || rendered.includes("| undefined")) return "undefined";
    if (containsDate(type)) return "non-durable";
  }
}

function containsDate(type: Type): boolean {
  if (type.isUnionType() || type.isIntersectionType()) return type.getTypes()?.some(containsDate) ?? false;
  return type.getSymbol()?.name === "Date" || type.getAliasSymbol()?.name === "Date";
}
