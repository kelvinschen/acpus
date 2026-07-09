import type { DiagnosticIR } from "@acpus/core/ir";
import { expressionCallbackOperatorNames, expressionOperatorSpec, type ExpressionCallbackOperatorName } from "@acpus/expression/ir";
import ts from "typescript";
import { execFunction } from "../../task-analysis/ast.js";
import { findTaskCallsites, type TaskCallsiteIssueReason, unjoinableTaskCallsiteReason } from "../../task-analysis/callsites.js";
import { collectFreeIdentifierNodes, isRuntimeGlobalIdentifier, isRuntimeGlobalName } from "../../task-analysis/capture-analysis.js";
import { analyzeTaskAuthoring, type TaskAuthoringIssue, type WorkflowTaskAnalysis } from "../../task-analysis/index.js";
import { checkOutputAdmissibility, workflowDataAdmissibilityDiagnostic } from "./output-admissibility.js";

// Acpus authoring rules are the product check rules used by
// checkWorkflow(...) and prepareWorkflow(...). They intentionally do not invoke
// ESLint or read user/editor ESLint configuration. The internal ESLint plugin
// is only an adapter for fixture review: @typescript-eslint/parser supplies a
// TypeScript Program, then the plugin delegates back to this module.

export type AuthoringRulesInput = {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  taskAnalysis: WorkflowTaskAnalysis;
};

export function checkWorkflowAuthoring(input: AuthoringRulesInput): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  const checker = input.program.getTypeChecker();
  checkExprAuthoring(input.sourceFile, checker, diagnostics);
  diagnostics.push(...checkOutputAdmissibility(outputAdmissibilitySources(input.program, input.sourceFile), checker));
  checkTaskAuthoring(input.taskAnalysis, diagnostics);
  checkInlineTaskShadowedGlobalCapture(input.sourceFile, checker, diagnostics);
  return diagnostics;
}

function outputAdmissibilitySources(program: ts.Program, entry: ts.SourceFile): ts.SourceFile[] {
  const sources: ts.SourceFile[] = [];
  const seen = new Set<string>();

  const visit = (sourceFile: ts.SourceFile): void => {
    const fileName = sourceFile.fileName;
    if (seen.has(fileName) || excludedOutputAdmissibilitySource(sourceFile)) return;
    seen.add(fileName);
    sources.push(sourceFile);

    for (const specifier of localModuleSpecifiers(sourceFile)) {
      const resolved = ts.resolveModuleName(specifier, fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (!resolved) continue;
      const imported = program.getSourceFile(resolved.resolvedFileName);
      if (imported) visit(imported);
    }
  };

  visit(entry);
  return sources.length > 0 ? sources : [entry];
}

function excludedOutputAdmissibilitySource(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return true;
  const fileName = sourceFile.fileName.replace(/\\/g, "/");
  return fileName.includes("/node_modules/")
    || fileName.includes("/packages/core/src/")
    || fileName.includes("/packages/expression/src/");
}

function localModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const text = node.moduleSpecifier.text;
      if (text.startsWith(".") || text.startsWith("/")) specifiers.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

const ARRAY_METHODS = new Set(["map", "filter", "forEach", "reduce", "some", "every"]);
const COMPARISON_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function checkExprAuthoring(sourceFile: ts.SourceFile, checker: ts.TypeChecker, diagnostics: DiagnosticIR[]): void {
  const callbackImports = collectExpressionCallbackImports(sourceFile, checker);
  const visit = (node: ts.Node): void => {
    if (isConditionExpression(node) && isExpr(checker, node)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be used as JavaScript conditions.", node, "Use fmap(value, value => condition), lift2(...), lift3(...), or lift({ deps }, fn)."));
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isExpr(checker, node.operand)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be negated with JavaScript !.", node, "Use fmap(value, value => !value) or lift({ deps }, fn)."));
    }
    if (ts.isBinaryExpression(node)) {
      if ((node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        && (isExpr(checker, node.left) || isExpr(checker, node.right))) {
        diagnostics.push(diagnostic("AL002", "Expr values cannot use JavaScript logical operators at workflow authoring time.", node, "Use lift2(a, b, (a, b) => a && b) or lift({ deps }, fn)."));
      }
      if (COMPARISON_OPERATORS.has(node.operatorToken.kind) && (isExpr(checker, node.left) || isExpr(checker, node.right))) {
        diagnostics.push(diagnostic("AL003", "Expr values cannot use JavaScript comparison operators at workflow authoring time.", node, "Use lift2(a, b, (a, b) => a === b) or lift({ deps }, fn)."));
      }
    }
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent) && node.templateSpans.some(span => isExpr(checker, span.expression))) {
      diagnostics.push(diagnostic("AL004", "Expr values cannot be interpolated with untagged template literals.", node, "Use template or md from @acpus/expression."));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ARRAY_METHODS.has(node.expression.name.text) && isExpr(checker, node.expression.expression)) {
      diagnostics.push(diagnostic("AL005", "Expr accessors do not support JavaScript array methods at workflow authoring time.", node, "Use fmap(items, items => items.map/filter/length...), lift2(...), or lift({ deps }, fn)."));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "step") {
      const id = node.arguments[0];
      if (id && isExprDerived(checker, id)) {
        diagnostics.push(diagnostic("AL006", "Node ids cannot be derived from runtime Expr values.", id, "Node ids must be compile-time stable strings."));
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
        if (issue) diagnostics.push(diagnostic("AL007", issue.message, issue.node, issue.hint));
        else {
          const outputDiagnostic = expressionCallbackOutputDiagnostic(node, helper, checker);
          if (outputDiagnostic) diagnostics.push(outputDiagnostic);
        }
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
  return ts.isStringLiteral(node) && (node.text === "acpus/expression" || node.text === "@acpus/expression");
}

function expressionCallbackHelper(call: ts.CallExpression, imports: ExpressionCallbackImports, checker: ts.TypeChecker): ExpressionCallbackHelper | undefined {
  if (ts.isIdentifier(call.expression)) {
    const symbol = checker.getSymbolAtLocation(call.expression);
    return symbol ? imports.names.get(symbol) : undefined;
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const name = call.expression.name.text;
  if (!EXPRESSION_CALLBACK_HELPERS.has(name as ExpressionCallbackHelper)) return undefined;
  return ts.isIdentifier(call.expression.expression) && hasSymbol(imports.namespaces, checker, call.expression.expression)
    ? name as ExpressionCallbackHelper
    : undefined;
}

function hasSymbol(symbols: ReadonlySet<ts.Symbol>, checker: ts.TypeChecker, node: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol && symbols.has(symbol));
}

function expressionCallbackIssue(call: ts.CallExpression, helper: ExpressionCallbackHelper, checker: ts.TypeChecker): ExpressionCallbackIssue | undefined {
  const rule = expressionOperatorSpec(helper)?.callback;
  if (!rule) return undefined;
  const node = call.arguments[rule.callbackSourceArg];
  if (!node) return callbackIssue(`${helper}(...) requires an inline callback.`, call, callbackHint(helper));
  if (!ts.isArrowFunction(node)) {
    return callbackIssue(`${helper}(...) callback must be an inline one-expression arrow.`, node, callbackHint(helper));
  }
  const params = callbackParameterScope(node, rule.callbackParamCount);
  if (params.issue) {
    return callbackIssue(`${helper}(...) callback parameters must be simple identifiers or binding patterns.`, params.issue, callbackHint(helper));
  }
  if (ts.isBlock(node.body)) {
    return callbackIssue(`${helper}(...) callback must be one expression, not a block body.`, node.body, "Use value => expression instead of value => { return expression; }.");
  }
  return callbackExpressionIssue(node.body, params.names, checker, helper);
}

function expressionCallbackOutputDiagnostic(call: ts.CallExpression, helper: ExpressionCallbackHelper, checker: ts.TypeChecker): DiagnosticIR | undefined {
  const callbackIndex = expressionOperatorSpec(helper)?.callback?.callbackSourceArg;
  const callback = callbackIndex === undefined ? undefined : call.arguments[callbackIndex];
  if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body)) return undefined;
  const signature = checker.getSignatureFromDeclaration(callback);
  if (!signature) return undefined;
  const returnType = checker.getReturnTypeOfSignature(signature);
  return workflowDataAdmissibilityDiagnostic(`${helper} callback output`, callback.body, returnType, checker);
}

function visitExpressionCallbackDependencies(call: ts.CallExpression, helper: ExpressionCallbackHelper, visit: (node: ts.Node) => void): void {
  const callbackIndex = expressionOperatorSpec(helper)?.callback?.callbackSourceArg;
  call.arguments.forEach((arg, index) => {
    if (index !== callbackIndex) visit(arg);
  });
}

function callbackExpressionIssue(node: ts.Expression, scope: ReadonlySet<string>, checker: ts.TypeChecker, helper: ExpressionCallbackHelper): ExpressionCallbackIssue | undefined {
  if (ts.isParenthesizedExpression(node)) return callbackExpressionIssue(node.expression, scope, checker, helper);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return callbackExpressionIssue(node.expression, scope, checker, helper);
  }
  if (ts.isIdentifier(node)) return identifierIssue(node, scope, checker, helper);
  if (node.kind === ts.SyntaxKind.ThisKeyword) return callbackIssue(`${helper}(...) callback cannot use this.`, node, "Pass needed values through explicit dependencies.");
  if (ts.isPropertyAccessExpression(node)) return callbackExpressionIssue(node.expression, scope, checker, helper);
  if (ts.isElementAccessExpression(node)) return callbackExpressionIssue(node.expression, scope, checker, helper) ?? callbackExpressionIssue(node.argumentExpression, scope, checker, helper);
  if (ts.isShorthandPropertyAssignment(node)) return identifierIssue(node.name, scope, checker, helper);
  if (ts.isArrowFunction(node)) return nestedArrowIssue(node, scope, checker, helper);
  if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) return callbackIssue(`${helper}(...) callback can only define nested expression arrows.`, node, "Use an expression arrow callback or move complex logic into a Task.");
  let issue: ExpressionCallbackIssue | undefined;
  ts.forEachChild(node, child => {
    if (issue || ts.isTypeNode(child)) return;
    if (ts.isExpression(child) || ts.isShorthandPropertyAssignment(child) || ts.isArrowFunction(child)) issue = callbackExpressionIssue(child as ts.Expression, scope, checker, helper);
  });
  return issue;
}

function nestedArrowIssue(node: ts.ArrowFunction, outerScope: ReadonlySet<string>, checker: ts.TypeChecker, helper: ExpressionCallbackHelper): ExpressionCallbackIssue | undefined {
  const params = callbackParameterScope(node, node.parameters.length, outerScope);
  if (params.issue) return callbackIssue(`${helper}(...) nested callback parameters must be simple identifiers or binding patterns.`, params.issue, "Use item => expression.");
  if (ts.isBlock(node.body)) return callbackIssue(`${helper}(...) nested callbacks must be expression-body arrows.`, node.body, "Use item => expression instead of item => { return expression; }.");
  return callbackExpressionIssue(node.body, params.names, checker, helper);
}

function callbackParameterScope(node: ts.ArrowFunction, expectedCount: number, base: ReadonlySet<string> = new Set()): { names: Set<string>; issue?: ts.Node } {
  const names = new Set(base);
  if (node.parameters.length !== expectedCount) return { names, issue: node };
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken || parameter.initializer) return { names, issue: parameter };
    const ok = collectBindingNames(parameter.name, names);
    if (!ok) return { names, issue: parameter.name };
  }
  return { names };
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): boolean {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return true;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element) || element.dotDotDotToken || element.initializer) return false;
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) return false;
    if (!collectBindingNames(element.name, names)) return false;
  }
  return true;
}

function identifierIssue(node: ts.Identifier, scope: ReadonlySet<string>, checker: ts.TypeChecker, helper: ExpressionCallbackHelper): ExpressionCallbackIssue | undefined {
  if (scope.has(node.text) || isRuntimeGlobalIdentifier(node, checker)) return undefined;
  return callbackIssue(`${helper}(...) callback cannot reference external binding '${node.text}'.`, node, dependencyHint(helper));
}

function callbackHint(helper: ExpressionCallbackHelper): string {
  if (helper === "fmap") return "Use fmap(value, value => expression).";
  if (helper === "lift2") return "Use lift2(a, b, (a, b) => expression).";
  if (helper === "lift3") return "Use lift3(a, b, c, (a, b, c) => expression).";
  return "Use lift({ namedDeps }, ({ namedDeps }) => expression).";
}

function dependencyHint(helper: ExpressionCallbackHelper): string {
  if (helper === "fmap") return "Pass every runtime dependency explicitly; use lift2, lift3, or lift({ deps }, fn) when the expression needs more values.";
  return "Add the value to the explicit dependency list and read it from the callback parameter.";
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
        code: "TB004",
        message: `Reusable task '${issue.name}' is not exported from a loadable task module.`,
        hint: "Export the top-level task.define(...) value from the workflow module, move it to an exported task module, or use an inline self-contained task.",
      };
    case "invalid-reusable-task-reference":
      return {
        ...base,
        code: "TB005",
        message: issue.name
          ? `Reusable task '${issue.name}' must reference a task.define(...) export.`
          : "Reusable task must reference a task.define(...) export.",
        hint: "Pass an imported or same-file exported task.define(...) token as run.task.",
      };
    case "invalid-reusable-task-export":
      return {
        ...base,
        code: "TB005",
        message: `Reusable task export '${issue.importedName}' must be initialized with task.define(...).`,
        hint: "Export a task.define(...) token from the task module.",
      };
    case "inline-task-capture":
      return {
        ...base,
        code: "TB007",
        message: `Inline task is not self-contained; it references ${issue.names.map(name => `'${name}'`).join(", ")}.`,
        hint: "Move captured logic into a reusable task.define(...) module or pass data through run.input.",
      };
    case "ambiguous-task-callsite":
      return {
        ...base,
        code: "TB008",
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
      return diagnostic("TB008", "Task callsite cannot be joined to task metadata through a saved step declaration.", node, "Inline the task call as step(\"id\").task({...}).");
    case "non-object-task-spec":
      return diagnostic("TB008", "Task callsite cannot be joined to task metadata because the task spec is not an object literal.", node, "Pass the task spec as an object literal directly to .task(...).");
    case "non-literal-task-id":
      return diagnostic("TB008", "Task callsite cannot be joined to task metadata because the task step id is not a literal string.", node, "Use a literal task step id for task metadata checks.");
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
