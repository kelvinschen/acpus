import type { DiagnosticIR } from "@acpus/core/ir";
import { expressionCallbackLayout, expressionCallbackOperatorNames, type ExpressionCallbackOperatorName } from "@acpus/expression/ir";
import ts from "typescript";
import { execFunction } from "../../task-analysis/ast.js";
import { findTaskCallsites, type TaskCallsiteIssueReason, unjoinableTaskCallsiteReason } from "../../task-analysis/callsites.js";
import { collectFreeIdentifierNodes, isRuntimeGlobalName } from "../../task-analysis/capture-analysis.js";
import { analyzeTaskAuthoring, type TaskAuthoringIssue, type WorkflowTaskAnalysis } from "../../task-analysis/index.js";

// Acpus authoring rules are the product check rules used by
// checkWorkflow(...) and prepareWorkflow(...). They intentionally do not invoke
// ESLint or read user/editor ESLint configuration.

export type AuthoringRulesInput = {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  taskAnalysis: WorkflowTaskAnalysis;
};

export function checkWorkflowAuthoring(input: AuthoringRulesInput): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  const checker = input.program.getTypeChecker();
  checkExprAuthoring(input.sourceFile, checker, diagnostics);
  checkTaskAuthoring(input.taskAnalysis, diagnostics);
  checkInlineTaskShadowedGlobalCapture(input.sourceFile, checker, diagnostics);
  return diagnostics;
}

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function checkExprAuthoring(sourceFile: ts.SourceFile, checker: ts.TypeChecker, diagnostics: DiagnosticIR[]): void {
  const callbackImports = collectExpressionCallbackImports(sourceFile, checker);
  const visit = (node: ts.Node): void => {
    if (isConditionExpression(node) && isExpr(checker, node)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be used as JavaScript conditions.", node, "Use lift(value, value => condition) or an expression predicate helper."));
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isExpr(checker, node.operand)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be negated with JavaScript !.", node, "Use lift(value, value => !value) or the not helper."));
    }
    if (ts.isBinaryExpression(node)) {
      if ((node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        && (isExpr(checker, node.left) || isExpr(checker, node.right))) {
        diagnostics.push(diagnostic("AL002", "Expr values cannot use JavaScript logical operators at workflow authoring time.", node, "Use lift(a, b, (a, b) => a && b) or the and/or helpers."));
      }
      if (EQUALITY_OPERATORS.has(node.operatorToken.kind)
        && (isExpr(checker, node.left) || isExpr(checker, node.right))
        && typesOverlap(checker, node.left, node.right)) {
        diagnostics.push(diagnostic("AL003", "Expr values cannot use JavaScript equality operators at workflow authoring time.", node, "Use lift(a, b, (a, b) => a === b) or the eq/ne helpers."));
      }
    }
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent) && node.templateSpans.some(span => isExpr(checker, span.expression))) {
      diagnostics.push(diagnostic("AL004", "Expr values cannot be interpolated with untagged template literals.", node, "Use template or md from acpus/expression."));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "step") {
      const id = node.arguments[0];
      if (id && isStringAssignable(checker, id) && isExprDerived(checker, id)) {
        diagnostics.push(diagnostic("AL005", "Node ids cannot be derived from runtime Expr values.", id, "Node ids must be compile-time stable strings."));
      }
    }
    const unjoinableReason = unjoinableTaskCallsiteReason(node, checker);
    if (unjoinableReason) {
      diagnostics.push(taskCallsiteDiagnostic(unjoinableReason, node));
    }
    if (ts.isCallExpression(node)) {
      const helper = expressionCallbackHelper(node, callbackImports, checker);
      if (helper) {
        const issue = expressionCallbackIssue(node, helper, checker);
        if (issue) diagnostics.push(diagnostic("AL006", issue.message, issue.node, issue.hint));
        visitExpressionCallbackDependencies(node, helper, visit);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

type ExpressionCallbackHelper = ExpressionCallbackOperatorName;

type ExpressionCallbackImports = {
  names: Map<ts.Symbol, ExpressionCallbackHelper>;
  namespaces: Set<ts.Symbol>;
};

type ExpressionCallbackIssue = {
  node: ts.Node;
  message: string;
  hint: string;
};

const EXPRESSION_CALLBACK_HELPERS = new Set<ExpressionCallbackHelper>(expressionCallbackOperatorNames());

function collectExpressionCallbackImports(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ExpressionCallbackImports {
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

function addSymbol(symbols: Set<ts.Symbol>, checker: ts.TypeChecker, node: ts.Identifier): void {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) symbols.add(symbol);
}

function isExpressionFacadeSpecifier(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) && node.text === "acpus/expression";
}

function expressionCallbackHelper(call: ts.CallExpression, imports: ExpressionCallbackImports, checker: ts.TypeChecker): ExpressionCallbackHelper | undefined {
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
  checker: ts.TypeChecker,
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
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function hasSymbol(symbols: ReadonlySet<ts.Symbol>, checker: ts.TypeChecker, node: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol && symbols.has(symbol));
}

function expressionCallbackIssue(call: ts.CallExpression, helper: ExpressionCallbackHelper, checker: ts.TypeChecker): ExpressionCallbackIssue | undefined {
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) {
    return callbackIssue(`${helper}(...) dependencies and callback must be passed as direct arguments.`, spread, callbackHint());
  }
  const layout = expressionCallbackLayout(helper, call.arguments.length);
  if (!layout) return undefined;
  const node = call.arguments[layout.callbackSourceArg];
  if (!node) return undefined;
  if (!ts.isArrowFunction(node)) {
    if (checker.getTypeAtLocation(node).getCallSignatures().length === 0) return undefined;
    return callbackIssue(`${helper}(...) callback must be an inline arrow function.`, node, callbackHint());
  }
  const parameterIssue = callbackParameterIssue(node, layout.callbackParamCount);
  if (parameterIssue) {
    return callbackIssue(`${helper}(...) callback parameters must match its dependencies and use simple identifiers or binding patterns.`, parameterIssue, callbackHint());
  }
  return callbackBodyIssue(node, checker);
}

function visitExpressionCallbackDependencies(call: ts.CallExpression, helper: ExpressionCallbackHelper, visit: (node: ts.Node) => void): void {
  const callbackIndex = expressionCallbackLayout(helper, call.arguments.length)?.callbackSourceArg;
  call.arguments.forEach((arg, index) => {
    if (index !== callbackIndex) visit(arg);
  });
}

function callbackBodyIssue(callback: ts.ArrowFunction, checker: ts.TypeChecker): ExpressionCallbackIssue | undefined {
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
        issue = callbackIssue("lift(...) nested callback parameters must be simple identifiers or binding patterns.", parameterIssue, "Use item => expression or item => { return expression; }.");
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  if (issue) return issue;
  const external = collectFreeIdentifierNodes(callback, checker)[0];
  return external
    ? callbackIssue(`lift(...) callback cannot reference external binding '${external.name}'.`, external.node, dependencyHint())
    : undefined;
}

function callbackParameterIssue(node: ts.ArrowFunction, expectedCount: number): ts.Node | undefined {
  if (node.parameters.length < expectedCount) return node;
  if (node.parameters.length > expectedCount) return undefined;
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken || parameter.initializer) return parameter;
    if (!isSimpleBindingName(parameter.name)) return parameter.name;
  }
}

function isSimpleBindingName(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return true;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element) || element.dotDotDotToken || element.initializer) return false;
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) return false;
    if (!isSimpleBindingName(element.name)) return false;
  }
  return true;
}

function callbackHint(): string {
  return "Use lift(value, value => expression), lift(a, b, (a, b) => expression), or lift({ namedDeps }, ({ namedDeps }) => expression).";
}

function dependencyHint(): string {
  return "Add the value to lift's explicit dependency list and read it from the matching callback parameter; use a named object dependency when names matter.";
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

function isExprDerived(checker: ts.TypeChecker, node: ts.Node): boolean {
  if (isExpr(checker, node)) return true;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(child) && isExpr(checker, child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function isExpr(checker: ts.TypeChecker, node: ts.Node): boolean {
  return hasExprMarker(checker.getTypeAtLocation(node));
}

function hasExprMarker(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(hasExprMarker);
  return Boolean(type.getProperty("__ir"));
}

function typesOverlap(checker: ts.TypeChecker, left: ts.Expression, right: ts.Expression): boolean {
  const leftType = checker.getTypeAtLocation(left);
  const rightType = checker.getTypeAtLocation(right);
  return checker.isTypeAssignableTo(leftType, rightType) || checker.isTypeAssignableTo(rightType, leftType);
}

function isStringAssignable(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return checker.isTypeAssignableTo(checker.getTypeAtLocation(node), checker.getStringType());
}

function checkInlineTaskShadowedGlobalCapture(sourceFile: ts.SourceFile, checker: ts.TypeChecker, diagnostics: DiagnosticIR[]): void {
  for (const callsite of findTaskCallsites(sourceFile)) {
    const exec = execFunction(callsite.options);
    if (!exec) continue;
    const shadowedGlobals = collectFreeIdentifierNodes(exec, checker)
      .map(identifier => identifier.name)
      .filter(isRuntimeGlobalName);
    if (shadowedGlobals.length === 0) continue;
    diagnostics.push(taskDiagnostic(callsite.stepId, { kind: "inline-task-capture", names: shadowedGlobals }, callsite.source));
  }
}

function checkTaskAuthoring(taskAnalysis: WorkflowTaskAnalysis, diagnostics: DiagnosticIR[]): void {
  for (const fact of analyzeTaskAuthoring(taskAnalysis)) {
    if (!fact.issue) continue;
    diagnostics.push(taskDiagnostic(fact.stepId, fact.issue, fact.source));
  }
}

function taskDiagnostic(stepId: string, issue: TaskAuthoringIssue, source: DiagnosticIR["source"]): DiagnosticIR {
  const base = {
    severity: "error" as const,
    path: taskIssuePath(stepId, issue),
    ...(source ? { source } : {}),
  };
  switch (issue.kind) {
    case "workflow-local-reusable-task":
      return {
        ...base,
        code: "TB001",
        message: `Reusable task '${issue.name}' is not exported from a loadable task module.`,
        hint: "Export the top-level task.define(...) value from the workflow module, move it to an exported task module, or use an inline self-contained task.",
      };
    case "invalid-reusable-task-reference":
      return {
        ...base,
        code: "TB002",
        message: issue.name
          ? `Reusable task '${issue.name}' must reference a task.define(...) export.`
          : "Reusable task must reference a task.define(...) export.",
        hint: "Pass an imported or same-file exported task.define(...) token through the top-level task field.",
      };
    case "invalid-reusable-task-export":
      return {
        ...base,
        code: "TB002",
        message: `Reusable task export '${issue.importedName}' must be initialized with task.define(...).`,
        hint: "Export a task.define(...) token from the task module and pass it through the top-level task field.",
      };
    case "inline-task-capture":
      return {
        ...base,
        code: "TB003",
        message: `Inline task is not self-contained; it references ${issue.names.map(name => `'${name}'`).join(", ")}.`,
        hint: "Move captured logic into a reusable task.define(...) module or pass data through the top-level input field.",
      };
    case "ambiguous-task-callsite":
      return {
        ...base,
        code: "TB004",
        message: `Task callsite '${stepId}' cannot be joined to task metadata because the task step id is used multiple times.`,
        hint: "Use unique task step ids so task metadata can be joined unambiguously.",
      };
  }
}

function taskIssuePath(stepId: string, issue: TaskAuthoringIssue): string {
  const suffix = issue.kind === "inline-task-capture" ? ".source" : ".reference";
  return `tasks.${stepId}${suffix}`;
}

function diagnostic(code: string, message: string, node: ts.Node, hint: string): DiagnosticIR {
  return {
    code,
    severity: "error",
    message,
    hint,
    source: sourceLocation(node),
  };
}

function taskCallsiteDiagnostic(reason: TaskCallsiteIssueReason, node: ts.Node): DiagnosticIR {
  switch (reason) {
    case "saved-step-declaration":
      return diagnostic("TB004", "Task callsite cannot be joined to task metadata through a saved step declaration.", node, "Inline the task call as step(\"id\").task({...}).");
    case "non-object-task-spec":
      return diagnostic("TB004", "Task callsite cannot be joined to task metadata because the task spec is not an object literal.", node, "Pass the task spec as an object literal directly to .task(...).");
    case "non-literal-task-id":
      return diagnostic("TB004", "Task callsite cannot be joined to task metadata because the task step id is not a literal string.", node, "Use a literal task step id for task metadata checks.");
  }
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
