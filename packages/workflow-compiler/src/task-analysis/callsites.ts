import ts from "typescript";
import type { TaskCallsite, TaskSourceLocation } from "./types.js";

export type TaskCallsiteIssueReason =
  | "saved-step-declaration"
  | "non-object-task-spec"
  | "non-literal-task-id";

type TaskCallsiteClassification =
  | { kind: "joinable"; callsite: TaskCallsite }
  | { kind: "unjoinable"; reason: TaskCallsiteIssueReason }
  | { kind: "none" };

export function findTaskCallsites(sourceFile: ts.SourceFile): TaskCallsite[] {
  const callsites: TaskCallsite[] = [];
  const visit = (node: ts.Node): void => {
    const callsite = classifyTaskCallsite(node);
    if (callsite.kind === "joinable") callsites.push(callsite.callsite);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callsites;
}

export function unjoinableTaskCallsiteReason(node: ts.Node, checker: ts.TypeChecker): TaskCallsiteIssueReason | undefined {
  const callsite = classifyTaskCallsite(node, checker);
  return callsite.kind === "unjoinable" ? callsite.reason : undefined;
}

function classifyTaskCallsite(node: ts.Node, checker?: ts.TypeChecker): TaskCallsiteClassification {
  if (!ts.isCallExpression(node)) return { kind: "none" };
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return { kind: "none" };
  const joinable = matchJoinableTaskCallsite(node);
  if (joinable) return { kind: "joinable", callsite: joinable };
  const directStepReason = directStepCallIssueReason(node);
  if (directStepReason) return { kind: "unjoinable", reason: directStepReason };
  if (checker && isAcpusStepDeclaration(callee.expression, checker)) {
    return { kind: "unjoinable", reason: "saved-step-declaration" };
  }
  return { kind: "none" };
}

function matchJoinableTaskCallsite(node: ts.CallExpression): TaskCallsite | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return undefined;
  const stepCall = callee.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return undefined;
  const id = stepCall.arguments[0];
  if (!id || !ts.isStringLiteral(id)) return undefined;
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return { stepId: id.text, options, source: sourceLocation(node) };
}

function directStepCallIssueReason(node: ts.CallExpression): TaskCallsiteIssueReason | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return undefined;
  const stepCall = callee.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return undefined;
  const id = stepCall.arguments[0];
  if (!id || !ts.isStringLiteral(id)) return "non-literal-task-id";
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return "non-object-task-spec";
  return undefined;
}

function isAcpusStepDeclaration(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node);
  return type.aliasSymbol?.name === "StepDeclaration";
}

function sourceLocation(node: ts.Node): TaskSourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
  };
}
