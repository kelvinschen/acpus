import * as ts from "typescript/unstable/ast";
import type { Checker, Project } from "typescript/unstable/sync";
import {
  isOfficialStepDeclaration,
  isOfficialStepFactory,
  type OfficialAuthoringRoots,
} from "../check/official-types.js";
import type { TaskCallsite, TaskSourceLocation } from "./types.js";

export type TaskCallsiteIssueReason =
  | "saved-step-declaration"
  | "non-object-task-spec"
  | "non-literal-task-id";

type TaskCallsiteClassification =
  | { kind: "joinable"; callsite: TaskCallsite }
  | { kind: "unjoinable"; reason: TaskCallsiteIssueReason }
  | { kind: "none" };

export type TaskCallsiteSemanticContext = {
  checker: Checker;
  project: Project;
  roots: OfficialAuthoringRoots;
};

export function findTaskCallsites(sourceFile: ts.SourceFile, semantic?: TaskCallsiteSemanticContext): TaskCallsite[] {
  const callsites: TaskCallsite[] = [];
  const visit = (node: ts.Node): void => {
    const callsite = classifyTaskCallsite(node, semantic);
    if (callsite.kind === "joinable") callsites.push(callsite.callsite);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return callsites;
}

export function unjoinableTaskCallsiteReason(node: ts.Node, semantic: TaskCallsiteSemanticContext): TaskCallsiteIssueReason | undefined {
  const callsite = classifyTaskCallsite(node, semantic);
  return callsite.kind === "unjoinable" ? callsite.reason : undefined;
}

function classifyTaskCallsite(node: ts.Node, semantic?: TaskCallsiteSemanticContext): TaskCallsiteClassification {
  if (!ts.isCallExpression(node)) return { kind: "none" };
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return { kind: "none" };
  const joinable = matchJoinableTaskCallsite(node, semantic);
  if (joinable) return { kind: "joinable", callsite: joinable };
  const directStepReason = directStepCallIssueReason(node, semantic);
  if (directStepReason) return { kind: "unjoinable", reason: directStepReason };
  if (semantic && isOfficialStepDeclaration(semantic.checker, semantic.project, semantic.roots, callee.expression)) {
    return { kind: "unjoinable", reason: "saved-step-declaration" };
  }
  return { kind: "none" };
}

function matchJoinableTaskCallsite(node: ts.CallExpression, semantic?: TaskCallsiteSemanticContext): TaskCallsite | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return undefined;
  const stepCall = callee.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return undefined;
  if (semantic && !isOfficialStepFactory(semantic.checker, semantic.project, semantic.roots, stepCall.expression)) return undefined;
  const id = stepCall.arguments[0];
  if (!id || !ts.isStringLiteral(id)) return undefined;
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return { stepId: id.text, options, source: sourceLocation(node) };
}

function directStepCallIssueReason(node: ts.CallExpression, semantic?: TaskCallsiteSemanticContext): TaskCallsiteIssueReason | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return undefined;
  const stepCall = callee.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return undefined;
  if (semantic && !isOfficialStepFactory(semantic.checker, semantic.project, semantic.roots, stepCall.expression)) return undefined;
  const id = stepCall.arguments[0];
  if (!id || !ts.isStringLiteral(id)) return "non-literal-task-id";
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return "non-object-task-spec";
  return undefined;
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
