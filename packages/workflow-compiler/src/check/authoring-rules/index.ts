import type { DiagnosticIR } from "@acpus/core/ir";
import { expressionCallbackLayout, expressionCallbackOperatorNames, type ExpressionCallbackOperatorName } from "@acpus/expression/ir";
import * as ts from "typescript/unstable/ast";
import { SignatureKind, type Checker, type Project, type Symbol } from "typescript/unstable/sync";
import { execFunction } from "../../task-analysis/ast.js";
import { findTaskCallsites, type TaskCallsiteIssueReason, unjoinableTaskCallsiteReason } from "../../task-analysis/callsites.js";
import {
  collectFreeIdentifierNodes,
  type SemanticCaptureContext,
} from "../../task-analysis/capture-analysis.js";
import { analyzeTaskAuthoring, type TaskAuthoringIssue, type WorkflowTaskAnalysis } from "../../task-analysis/index.js";
import { type AuthoringOwnership, type DiagnosticCandidate } from "../diagnostics.js";
import {
  isOfficialExpr,
  isOfficialStepDeclaration,
  isOfficialStepFactory,
  officialAuthoringRoots,
  type OfficialAuthoringRoots,
} from "../official-types.js";

// Acpus authoring rules are the product check rules used by
// checkWorkflow(...) and prepareWorkflow(...). They intentionally do not invoke
// ESLint or read user/editor ESLint configuration.

export type AuthoringRulesInput = {
  project: Project;
  sourceFile: ts.SourceFile;
  taskAnalysis: WorkflowTaskAnalysis;
  roots?: OfficialAuthoringRoots;
};

export function checkWorkflowAuthoring(input: AuthoringRulesInput): DiagnosticIR[] {
  return collectWorkflowAuthoringCandidates(input).map(candidate => candidate.diagnostic);
}

export function collectWorkflowAuthoringCandidates(input: AuthoringRulesInput): DiagnosticCandidate[] {
  const diagnostics: DiagnosticCandidate[] = [];
  const semantic = {
    checker: input.project.checker,
    program: input.project.program,
    project: input.project,
    roots: input.roots ?? officialAuthoringRoots(),
  };
  checkExplicitAny(input.sourceFile, diagnostics);
  checkExprAuthoring(input.sourceFile, semantic, diagnostics);
  checkTaskAuthoring(input.sourceFile, input.taskAnalysis, diagnostics);
  checkInlineTaskCaptures(input.sourceFile, semantic, diagnostics);
  diagnostics.forEach((candidate, sequence) => {
    candidate.sequence = sequence;
  });
  return diagnostics;
}

type AuthoringSemanticContext = SemanticCaptureContext & { roots: OfficialAuthoringRoots };

function checkExplicitAny(sourceFile: ts.SourceFile, diagnostics: DiagnosticCandidate[]): void {
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      diagnostics.push(diagnostic(
        "AL007",
        "Explicit 'any' is not allowed in Acpus workflow authoring.",
        node,
        "Use a precise type, or use unknown and narrow it before crossing an Acpus boundary.",
      ));
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
}

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const RELATIONAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function checkExprAuthoring(sourceFile: ts.SourceFile, semantic: AuthoringSemanticContext, diagnostics: DiagnosticCandidate[]): void {
  const checker = semantic.checker;
  const callbackImports = collectExpressionCallbackImports(sourceFile, checker);
  const visit = (node: ts.Node): void => {
    if (isConditionExpression(node) && isExpr(semantic, node)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be used as JavaScript conditions.", node, conditionHint(node), "expr-condition"));
    }
    if (node.parent && ts.isSwitchStatement(node.parent) && node.parent.expression === node && isExpr(semantic, node)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot control a JavaScript switch.", node, "Use step(\"id\").switch({ cases, default }) for graph control, with eq/ne or other predicates in each case.", "expr-switch"));
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isExpr(semantic, node.operand)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be negated with JavaScript !.", node, "Use not(value) for a boolean predicate, or lift(value, value => !value) to compute a value.", "expr-negation"));
    }
    if (ts.isBinaryExpression(node)) {
      if ((node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        && (isExpr(semantic, node.left) || isExpr(semantic, node.right))) {
        diagnostics.push(diagnostic("AL002", "Expr values cannot use JavaScript logical operators at workflow authoring time.", node, logicalHint(checker, node)));
      }
      if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && (isExpr(semantic, node.left) || isExpr(semantic, node.right))) {
        diagnostics.push(diagnostic("AL002", "Expr values cannot use JavaScript nullish coalescing at workflow authoring time.", node, "Use lift(value, value => value ?? fallback) for a literal fallback, or pass both runtime values as lift dependencies.", "expr-nullish"));
      }
      if (EQUALITY_OPERATORS.has(node.operatorToken.kind)
        && (isExpr(semantic, node.left) || isExpr(semantic, node.right))) {
        diagnostics.push(diagnostic("AL003", "Expr values cannot use JavaScript equality operators at workflow authoring time.", node, equalityHint(node.operatorToken.kind), "expr-equality"));
      }
      if (RELATIONAL_OPERATORS.has(node.operatorToken.kind)
        && (isExpr(semantic, node.left) || isExpr(semantic, node.right))) {
        diagnostics.push(diagnostic("AL003", "Expr values cannot use JavaScript relational operators at workflow authoring time.", node, relationalHint(node.operatorToken.kind), "expr-relational"));
      }
    }
    if (ts.isTemplateExpression(node)
      && !ts.isTaggedTemplateExpression(node.parent)
      && !isDirectStepId(node)
      && node.templateSpans.some(span => isExpr(semantic, span.expression))) {
      diagnostics.push(diagnostic("AL004", "Expr values cannot be interpolated with untagged template literals.", node, "Use template or md from acpus/expression."));
    }
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "step"
      && isOfficialStepFactory(checker, semantic.project, semantic.roots, node.expression)) {
      const id = node.arguments[0];
      if (id && isStringAssignable(checker, id) && isExprDerived(semantic, id)) {
        diagnostics.push(diagnostic("AL005", "Node ids cannot be derived from runtime Expr values.", id, stepIdHint(id, semantic)));
      }
    }
    const unjoinableReason = unjoinableTaskCallsiteReason(node, semantic);
    if (unjoinableReason && !(unjoinableReason === "non-literal-task-id" && hasExprDerivedStringTaskId(node, semantic))) {
      diagnostics.push(taskCallsiteDiagnostic(unjoinableReason, node));
    }
    if (ts.isCallExpression(node)) {
      const helper = expressionCallbackHelper(node, callbackImports, checker);
      if (helper) {
        const issue = expressionCallbackIssue(node, helper, semantic);
        if (issue) diagnostics.push(diagnostic("AL006", issue.message, issue.node, issue.hint));
        visitExpressionCallbackDependencies(node, helper, visit);
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
}

function conditionHint(node: ts.Expression): string {
  if (ts.isConditionalExpression(node.parent)) {
    return "Use lift(condition, value => value ? whenTrue : whenFalse) to compute a conditional value.";
  }
  if (ts.isIfStatement(node.parent)) {
    return "Use step(\"id\").if({ condition, then, else }) for graph control; use lift(condition, value => ...) only to compute a value.";
  }
  return "Use a graph loop for repeated work, or lift(condition, value => ...) only to compute a value.";
}

function logicalHint(checker: Checker, node: ts.BinaryExpression): string {
  if (isBooleanRuntimeValue(checker, node.left) && isBooleanRuntimeValue(checker, node.right)) {
    return node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? "Use and(left, right) for boolean Expr operands."
      : "Use or(left, right) for boolean Expr operands.";
  }
  return node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? "Use unary lift(value, value => value && result) when the other operand is literal, or pass both operands to binary lift."
    : "Use unary lift(value, value => value || \"fallback\") for a literal fallback, or pass both operands to binary lift.";
}

function isBooleanRuntimeValue(checker: Checker, node: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(node);
  if (!type || type.isErrorType()) return false;
  const marker = checker.getPropertyOfType(type, "__type");
  const runtimeType = marker ? checker.getTypeOfSymbolAtLocation(marker, node) : type;
  return checker.isTypeAssignableTo(runtimeType, checker.getBooleanType());
}

function equalityHint(operator: ts.SyntaxKind): string {
  return operator === ts.SyntaxKind.ExclamationEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ? "Use ne(left, right) for inequality over runtime values."
    : "Use eq(left, right) for equality over runtime values.";
}

function relationalHint(operator: ts.SyntaxKind): string {
  const helper = operator === ts.SyntaxKind.LessThanToken
    ? "lt"
    : operator === ts.SyntaxKind.LessThanEqualsToken
      ? "lte"
      : operator === ts.SyntaxKind.GreaterThanToken
        ? "gt"
        : "gte";
  return `Use ${helper}(left, right) for this comparison over runtime values.`;
}

function hasExprDerivedStringTaskId(node: ts.Node, semantic: AuthoringSemanticContext): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "task") return false;
  const stepCall = node.expression.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return false;
  if (!isOfficialStepFactory(semantic.checker, semantic.project, semantic.roots, stepCall.expression)) return false;
  const id = stepCall.arguments[0];
  return Boolean(id && isStringAssignable(semantic.checker, id) && isExprDerived(semantic, id));
}

function stepIdHint(node: ts.Node, semantic: AuthoringSemanticContext): string {
  return isLoopOrFanoutCallback(node, semantic)
    ? "Use one static step id inside loop and fanout callbacks; runtime instance paths already give each execution a distinct nodeKey."
    : "Use a compile-time string literal such as step(\"review\"); node ids are static graph identity.";
}

function isLoopOrFanoutCallback(node: ts.Node, semantic: AuthoringSemanticContext): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLikeDeclaration(current)) continue;
    const member = ts.isMethodDeclaration(current) ? current : current.parent;
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member)) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
    if (name !== "do") continue;
    const object = member.parent;
    const call = ts.isObjectLiteralExpression(object) ? object.parent : undefined;
    if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) continue;
    return (call.expression.name.text === "loop" || call.expression.name.text === "fanout")
      && isOfficialStepDeclaration(semantic.checker, semantic.project, semantic.roots, call.expression.expression);
  }
  return false;
}

function isDirectStepId(node: ts.Expression): boolean {
  let expression = node;
  while (
    (ts.isParenthesizedExpression(expression.parent)
      || ts.isAssertionExpression(expression.parent)
      || ts.isNonNullExpression(expression.parent)
      || ts.isSatisfiesExpression(expression.parent))
    && expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return ts.isCallExpression(parent)
    && ts.isIdentifier(parent.expression)
    && parent.expression.text === "step"
    && parent.arguments[0] === expression;
}

type ExpressionCallbackHelper = ExpressionCallbackOperatorName;

type ExpressionCallbackImports = {
  names: Map<Symbol, ExpressionCallbackHelper>;
  namespaces: Set<Symbol>;
};

type ExpressionCallbackIssue = {
  node: ts.Node;
  message: string;
  hint: string;
};

const EXPRESSION_CALLBACK_HELPERS = new Set<ExpressionCallbackHelper>(expressionCallbackOperatorNames());

function collectExpressionCallbackImports(sourceFile: ts.SourceFile, checker: Checker): ExpressionCallbackImports {
  const imports: ExpressionCallbackImports = { names: new Map(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !isExpressionFacadeSpecifier(statement.moduleSpecifier)) continue;
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      addSymbol(imports.namespaces, checker, namedBindings.name);
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!EXPRESSION_CALLBACK_HELPERS.has(imported as ExpressionCallbackHelper)) continue;
      const symbol = checker.getSymbolAtLocation(element.name);
      if (symbol) imports.names.set(symbol, imported as ExpressionCallbackHelper);
    }
  }
  return imports;
}

function addSymbol(symbols: Set<Symbol>, checker: Checker, node: ts.Identifier): void {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) symbols.add(symbol);
}

function isExpressionFacadeSpecifier(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) && node.text === "acpus/expression";
}

function expressionCallbackHelper(call: ts.CallExpression, imports: ExpressionCallbackImports, checker: Checker): ExpressionCallbackHelper | undefined {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const symbol = checker.getSymbolAtLocation(callee);
    return symbol ? imports.names.get(symbol) : undefined;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return namespaceExpressionCallbackHelper(callee.expression, callee.name.text, imports, checker);
  }
  if (!ts.isElementAccessExpression(callee) || !callee.argumentExpression) return undefined;
  const argument = unwrapTransparentExpression(callee.argumentExpression);
  return ts.isStringLiteral(argument)
    ? namespaceExpressionCallbackHelper(callee.expression, argument.text, imports, checker)
    : undefined;
}

function namespaceExpressionCallbackHelper(
  receiver: ts.Expression,
  name: string,
  imports: ExpressionCallbackImports,
  checker: Checker,
): ExpressionCallbackHelper | undefined {
  if (!EXPRESSION_CALLBACK_HELPERS.has(name as ExpressionCallbackHelper)) return undefined;
  const namespace = unwrapTransparentExpression(receiver);
  return ts.isIdentifier(namespace) && hasSymbol(imports.namespaces, checker, namespace)
    ? name as ExpressionCallbackHelper
    : undefined;
}

function unwrapTransparentExpression(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node)
    || ts.isAssertionExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function hasSymbol(symbols: ReadonlySet<Symbol>, checker: Checker, node: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol && symbols.has(symbol));
}

function expressionCallbackIssue(call: ts.CallExpression, helper: ExpressionCallbackHelper, semantic: SemanticCaptureContext): ExpressionCallbackIssue | undefined {
  const checker = semantic.checker;
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) {
    return callbackIssue(`${helper}(...) dependencies and callback must be passed as direct arguments.`, spread, callbackHint());
  }
  const layout = expressionCallbackLayout(helper, call.arguments.length);
  if (!layout) return undefined;
  const node = call.arguments[layout.callbackSourceArg];
  if (!node) return undefined;
  if (!ts.isArrowFunction(node)) {
    const type = checker.getTypeAtLocation(node);
    if (!type || checker.getSignaturesOfType(type, SignatureKind.Call).length === 0) return undefined;
    return callbackIssue(`${helper}(...) callback must be an inline arrow function.`, node, callbackHint());
  }
  const parameterIssue = callbackParameterIssue(node, layout.callbackParamCount);
  if (parameterIssue) {
    return callbackIssue(`${helper}(...) callback ${parameterIssue.message}`, parameterIssue.node, callbackHint());
  }
  return callbackBodyIssue(node, semantic);
}

function visitExpressionCallbackDependencies(call: ts.CallExpression, helper: ExpressionCallbackHelper, visit: (node: ts.Node) => void): void {
  const callbackIndex = expressionCallbackLayout(helper, call.arguments.length)?.callbackSourceArg;
  call.arguments.forEach((arg, index) => {
    if (index !== callbackIndex) visit(arg);
  });
}

function callbackBodyIssue(callback: ts.ArrowFunction, semantic: SemanticCaptureContext): ExpressionCallbackIssue | undefined {
  let issue: ExpressionCallbackIssue | undefined;
  const visit = (node: ts.Node): void => {
    if (issue || ts.isTypeNode(node)) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      issue = callbackIssue("lift(...) callback cannot use this.", node, "Pass needed values through explicit lift dependencies.");
      return;
    }
    if (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isClassExpression(node) || ts.isClassDeclaration(node)) {
      issue = callbackIssue("lift(...) callback can only define nested arrow functions.", node, "Use an arrow callback or move complex logic into a Task.");
      return;
    }
    if (ts.isArrowFunction(node)) {
      const parameterIssue = callbackParameterIssue(node, node.parameters.length);
      if (parameterIssue) {
        issue = callbackIssue(`lift(...) nested callback ${parameterIssue.message}`, parameterIssue.node, "Use item => expression or item => { return expression; }.");
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(callback.body);
  if (issue) return issue;
  const external = collectFreeIdentifierNodes(callback, semantic)[0];
  return external
    ? callbackIssue(`lift(...) callback cannot reference external binding '${external.name}'.`, external.node, dependencyHint())
    : undefined;
}

type CallbackParameterIssue = { node: ts.Node; message: string };

function callbackParameterIssue(node: ts.ArrowFunction, expectedCount: number): CallbackParameterIssue | undefined {
  if (node.parameters.length !== expectedCount) {
    return {
      node,
      message: `declares ${node.parameters.length} parameter(s) for ${expectedCount} explicit dependency value(s).`,
    };
  }
  for (const [index, parameter] of node.parameters.entries()) {
    if (parameter.dotDotDotToken) {
      return { node: parameter, message: `parameter ${index + 1} cannot be a rest parameter.` };
    }
    if (parameter.initializer) {
      return { node: parameter, message: `parameter ${index + 1} cannot use a default value.` };
    }
    const issue = bindingNameIssue(parameter.name);
    if (issue) return { node: issue.node, message: `parameter ${index + 1} ${issue.message}` };
  }
}

function bindingNameIssue(name: ts.BindingName): { node: ts.Node; message: string } | undefined {
  if (ts.isIdentifier(name)) return undefined;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element) || !element.name) return { node: element, message: "cannot contain an omitted binding." };
    if (element.dotDotDotToken) return { node: element, message: "cannot contain a rest binding." };
    if (element.initializer) return { node: element, message: "cannot contain a default value." };
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      return { node: element.propertyName, message: "cannot use a computed binding name." };
    }
    const nested = bindingNameIssue(element.name);
    if (nested) return nested;
  }
}

function callbackHint(): string {
  return "Use lift(value, value => expression), lift(a, b, (a, b) => expression), or lift({ namedDeps }, ({ namedDeps }) => expression).";
}

function dependencyHint(): string {
  return "Pass runtime values through lift's explicit dependencies, using a named object when useful. Do not pass helpers or functions; return plain data and apply md or template outside lift.";
}

function callbackIssue(message: string, node: ts.Node, hint: string): ExpressionCallbackIssue {
  return { message, node, hint };
}

function isConditionExpression(node: ts.Node): node is ts.Expression {
  const parent = node.parent;
  if (!parent) return false;
  return (ts.isIfStatement(parent) && parent.expression === node)
    || (ts.isWhileStatement(parent) && parent.expression === node)
    || (ts.isDoStatement(parent) && parent.expression === node)
    || (ts.isForStatement(parent) && parent.condition === node)
    || (ts.isConditionalExpression(parent) && parent.condition === node);
}

function isExprDerived(semantic: AuthoringSemanticContext, node: ts.Node): boolean {
  if (isExpr(semantic, node)) return true;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(child) && isExpr(semantic, child)) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

function isExpr(semantic: AuthoringSemanticContext, node: ts.Node): boolean {
  return isOfficialExpr(semantic.checker, semantic.project, semantic.roots, node);
}

function isStringAssignable(checker: Checker, node: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type && !type.isErrorType() && checker.isTypeAssignableTo(type, checker.getStringType()));
}

function checkInlineTaskCaptures(sourceFile: ts.SourceFile, semantic: AuthoringSemanticContext, diagnostics: DiagnosticCandidate[]): void {
  for (const callsite of findTaskCallsites(sourceFile, semantic)) {
    const exec = execFunction(callsite.options);
    if (!exec) continue;
    const identifiers = collectFreeIdentifierNodes(exec, semantic);
    if (identifiers.length === 0) continue;
    const names = [...new Set(identifiers.map(identifier => identifier.name))].sort((left, right) => left.localeCompare(right));
    const earliest = identifiers.reduce((left, right) => left.node.getStart(sourceFile) <= right.node.getStart(sourceFile) ? left : right);
    diagnostics.push(taskDiagnostic(
      sourceFile,
      callsite.stepId,
      { kind: "inline-task-capture", names },
      sourceLocation(earliest.node),
      earliest.node,
    ));
  }
}

function checkTaskAuthoring(sourceFile: ts.SourceFile, taskAnalysis: WorkflowTaskAnalysis, diagnostics: DiagnosticCandidate[]): void {
  for (const fact of analyzeTaskAuthoring(taskAnalysis)) {
    if (!fact.issue || fact.issue.kind === "inline-task-capture") continue;
    diagnostics.push(taskDiagnostic(sourceFile, fact.stepId, fact.issue, fact.source));
  }
}

function taskDiagnostic(
  sourceFile: ts.SourceFile,
  stepId: string,
  issue: TaskAuthoringIssue,
  source: DiagnosticIR["source"],
  node?: ts.Node,
): DiagnosticCandidate {
  const base = {
    severity: "error" as const,
    path: taskIssuePath(stepId, issue),
    ...(source ? { source } : {}),
  };
  let diagnostic: DiagnosticIR;
  switch (issue.kind) {
    case "workflow-local-reusable-task":
      diagnostic = {
        ...base,
        code: "TB001",
        message: `Reusable task '${issue.name}' is not exported from a loadable task module.`,
        hint: "Export the top-level task.define(...) value from the workflow module, move it to an exported task module, or use an inline self-contained task.",
      };
      break;
    case "invalid-reusable-task-reference":
      diagnostic = {
        ...base,
        code: "TB002",
        message: issue.name
          ? `Reusable task '${issue.name}' must reference a task.define(...) export.`
          : "Reusable task must reference a task.define(...) export.",
        hint: "Pass an imported or same-file exported task.define(...) token through the top-level task field.",
      };
      break;
    case "invalid-reusable-task-export":
      diagnostic = {
        ...base,
        code: "TB002",
        message: `Reusable task export '${issue.importedName}' must be initialized with task.define(...).`,
        hint: "Export a task.define(...) token from the task module and pass it through the top-level task field.",
      };
      break;
    case "inline-task-capture":
      diagnostic = {
        ...base,
        code: "TB003",
        message: `Inline task is not self-contained; it references ${issue.names.map(name => `'${name}'`).join(", ")}.`,
        hint: "Pass captured data through Task input. Move helper logic inside exec, dynamically import dependencies there, or use a reusable Task when module imports are required.",
      };
      break;
    case "ambiguous-task-callsite":
      const firstSource = issue.firstSource;
      diagnostic = {
        ...base,
        code: "TB004",
        message: `Task step id '${stepId}' is declared more than once, so Acpus cannot identify one Task definition.`,
        hint: firstSource
          ? `Use a unique literal id in step(\"${stepId}\").task({...}); the first declaration is at ${firstSource.line}:${firstSource.column}.`
          : `Use a unique literal id in step(\"${stepId}\").task({...}).`,
      };
      break;
  }
  const start = node?.getStart(sourceFile) ?? sourceOffset(sourceFile, source);
  return {
    diagnostic,
    origin: "authoring",
    sequence: 0,
    ...(source?.file ? { file: source.file } : {}),
    ...(start === undefined ? {} : { start, end: node?.end ?? start }),
  };
}

function taskIssuePath(stepId: string, issue: TaskAuthoringIssue): string {
  const suffix = issue.kind === "inline-task-capture" ? ".source" : ".reference";
  return `tasks.${stepId}${suffix}`;
}

function diagnostic(
  code: string,
  message: string,
  node: ts.Node,
  hint: string,
  ownership?: AuthoringOwnership,
): DiagnosticCandidate {
  return {
    diagnostic: {
      code,
      severity: "error",
      message,
      hint,
      source: sourceLocation(node),
    },
    origin: "authoring",
    file: node.getSourceFile().fileName,
    start: node.getStart(node.getSourceFile()),
    end: node.end,
    sequence: 0,
    ...(ownership ? { ownership } : {}),
  };
}

function taskCallsiteDiagnostic(reason: TaskCallsiteIssueReason, node: ts.Node): DiagnosticCandidate {
  switch (reason) {
    case "saved-step-declaration":
      return diagnostic("TB004", "A Task must be declared directly from a literal step id.", node, "Use step(\"literal\").task({...}) instead of saving the step declaration.");
    case "non-object-task-spec":
      return diagnostic("TB004", "A Task specification must be written directly at its step declaration.", node, "Use step(\"literal\").task({ input, exec }) or step(\"literal\").task({ input, task }).");
    case "non-literal-task-id":
      return diagnostic("TB004", "A Task step id must be a literal string.", node, "Use step(\"literal\").task({...}) so the Task has one static graph identity.");
  }
}

function sourceOffset(sourceFile: ts.SourceFile, source: DiagnosticIR["source"]): number | undefined {
  if (!source || source.file !== sourceFile.fileName || source.line === undefined || source.column === undefined) return undefined;
  const lines = sourceFile.text.split("\n");
  let offset = 0;
  for (let line = 1; line < source.line; line++) offset += (lines[line - 1]?.length ?? 0) + 1;
  return offset + Math.max(0, source.column - 1);
}

function sourceLocation(node: ts.Node): NonNullable<DiagnosticIR["source"]> {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
  };
}
