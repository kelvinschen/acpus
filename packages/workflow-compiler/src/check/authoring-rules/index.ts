import type { DiagnosticIR } from "@acpus/core/ir";
import ts from "typescript";
import { type TaskCallsiteIssueReason, unjoinableTaskCallsiteReason } from "../../task-analysis/callsites.js";
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
  const transformImports = collectTransformImports(sourceFile, checker);
  const visit = (node: ts.Node): void => {
    if (isConditionExpression(node) && isExpr(checker, node)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be used as JavaScript conditions.", node, "Use Acpus expression helpers such as where(...), every(...), ifElse(...), or not(...)."));
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isExpr(checker, node.operand)) {
      diagnostics.push(diagnostic("AL001", "Expr values cannot be negated with JavaScript !.", node, "Use not(expr) instead."));
    }
    if (ts.isBinaryExpression(node)) {
      if ((node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        && (isExpr(checker, node.left) || isExpr(checker, node.right))) {
        diagnostics.push(diagnostic("AL002", "Expr values cannot use JavaScript logical operators.", node, "Use and(...), or(...), every(...), or some(...) instead."));
      }
      if (COMPARISON_OPERATORS.has(node.operatorToken.kind) && (isExpr(checker, node.left) || isExpr(checker, node.right))) {
        diagnostics.push(diagnostic("AL003", "Expr values cannot use JavaScript comparison operators.", node, "Use eq, ne, lt, lte, gt, or gte from @acpus/expression."));
      }
    }
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent) && node.templateSpans.some(span => isExpr(checker, span.expression))) {
      diagnostics.push(diagnostic("AL004", "Expr values cannot be interpolated with untagged template literals.", node, "Use template or md from @acpus/expression."));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ARRAY_METHODS.has(node.expression.name.text) && isExpr(checker, node.expression.expression)) {
      diagnostics.push(diagnostic("AL005", "Expr accessors do not support JavaScript array methods at workflow authoring time.", node, "Use Acpus collection helpers such as map(...), filter(...), every(...), or some(...)."));
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
    if (ts.isCallExpression(node) && isTransformCall(node, transformImports, checker)) {
      const issue = transformCallbackIssue(node, checker);
      if (issue) diagnostics.push(diagnostic("AL007", issue.message, issue.node, issue.hint));
      else {
        const outputDiagnostic = transformOutputDiagnostic(node, checker);
        if (outputDiagnostic) diagnostics.push(outputDiagnostic);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

type TransformImports = {
  names: Set<ts.Symbol>;
  namespaces: Set<ts.Symbol>;
};

type TransformIssue = {
  node: ts.Node;
  message: string;
  hint: string;
};

function collectTransformImports(sourceFile: ts.SourceFile, checker: ts.TypeChecker): TransformImports {
  const imports: TransformImports = { names: new Set(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !isExpressionFacadeSpecifier(statement.moduleSpecifier)) continue;
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      addSymbol(imports.namespaces, checker, namedBindings.name);
      continue;
    }
    for (const element of namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === "transform") addSymbol(imports.names, checker, element.name);
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

function isTransformCall(call: ts.CallExpression, imports: TransformImports, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(call.expression)) return hasSymbol(imports.names, checker, call.expression);
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === "transform"
    && ts.isIdentifier(call.expression.expression)
    && hasSymbol(imports.namespaces, checker, call.expression.expression);
}

function hasSymbol(symbols: ReadonlySet<ts.Symbol>, checker: ts.TypeChecker, node: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol && symbols.has(symbol));
}

function transformCallbackIssue(call: ts.CallExpression, checker: ts.TypeChecker): TransformIssue | undefined {
  const node = call.arguments[1];
  if (!node) return transformIssue("transform(...) requires an inline callback.", call, "Pass a one-expression arrow such as value => value.title.");
  if (!ts.isArrowFunction(node)) {
    return transformIssue("transform(...) callback must be an inline one-expression arrow.", node, "Use value => value.title instead of a function expression or imported helper.");
  }
  if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    return transformIssue("transform(...) callback cannot be async.", node, "Return a JSON value synchronously.");
  }
  const parameterName = plainArrowParameterName(node);
  if (!parameterName) {
    return transformIssue("transform(...) callback must have exactly one plain parameter.", node, "Use a single parameter such as value => value.title.");
  }
  if (ts.isBlock(node.body)) {
    return transformIssue("transform(...) callback must be one expression, not a block body.", node.body, "Use value => expression instead of value => { return expression; }.");
  }
  return transformExpressionIssue(node.body, new Set([parameterName]), checker);
}

function transformOutputDiagnostic(call: ts.CallExpression, checker: ts.TypeChecker): DiagnosticIR | undefined {
  const callback = call.arguments[1];
  if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body)) return undefined;
  const signature = checker.getSignatureFromDeclaration(callback);
  if (!signature) return undefined;
  const returnType = checker.getReturnTypeOfSignature(signature);
  return workflowDataAdmissibilityDiagnostic("transform callback output", callback.body, returnType, checker);
}

function transformExpressionIssue(node: ts.Expression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  if (ts.isParenthesizedExpression(node)) return transformExpressionIssue(node.expression, scope, checker);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return transformExpressionIssue(node.expression, scope, checker);
  }
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return undefined;
  if (ts.isIdentifier(node)) return scope.has(node.text) ? undefined : transformIssue(`transform(...) callback cannot reference '${node.text}'.`, node, "Use only the callback parameter and allowed pure globals Object or Math.");
  if (node.kind === ts.SyntaxKind.ThisKeyword) return transformIssue("transform(...) callback cannot use this.", node, "Use the callback parameter explicitly.");
  if (ts.isPropertyAccessExpression(node)) return transformExpressionIssue(node.expression, scope, checker);
  if (ts.isElementAccessExpression(node)) return transformExpressionIssue(node.expression, scope, checker) ?? transformExpressionIssue(node.argumentExpression, scope, checker);
  if (ts.isObjectLiteralExpression(node)) return transformObjectLiteralIssue(node, scope, checker);
  if (ts.isArrayLiteralExpression(node)) return firstIssue(node.elements, element => ts.isSpreadElement(element) ? transformIssue("transform(...) callback cannot use spread syntax.", element, "Build explicit JSON arrays and objects.") : transformExpressionIssue(element, scope, checker));
  if (ts.isConditionalExpression(node)) return transformExpressionIssue(node.condition, scope, checker) ?? transformExpressionIssue(node.whenTrue, scope, checker) ?? transformExpressionIssue(node.whenFalse, scope, checker);
  if (ts.isTemplateExpression(node)) return firstIssue(node.templateSpans, span => transformExpressionIssue(span.expression, scope, checker));
  if (ts.isNoSubstitutionTemplateLiteral(node)) return undefined;
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) return transformIssue("transform(...) callback cannot mutate values.", node, "Use a pure expression without assignment or update operators.");
    return transformExpressionIssue(node.operand, scope, checker);
  }
  if (ts.isBinaryExpression(node)) return transformBinaryIssue(node, scope, checker);
  if (ts.isCallExpression(node)) return transformCallIssue(node, scope, checker);
  if (ts.isAwaitExpression(node)) return transformIssue("transform(...) callback cannot use await.", node, "Return a synchronous JSON value.");
  if (ts.isYieldExpression(node)) return transformIssue("transform(...) callback cannot use yield.", node, "Return a direct JSON value.");
  if (ts.isNewExpression(node)) return transformIssue("transform(...) callback cannot use new.", node, "Return plain JSON values.");
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return transformIssue("transform(...) callback cannot define nested functions except allowed array callbacks.", node, "Keep transform callbacks as one pure expression.");
  if (ts.isClassExpression(node)) return transformIssue("transform(...) callback cannot define classes.", node, "Return plain JSON values.");
  if (ts.isCommaListExpression(node)) return transformIssue("transform(...) callback cannot use comma expressions.", node, "Use a direct expression.");
  if (ts.isPostfixUnaryExpression(node)) return transformIssue("transform(...) callback cannot mutate values.", node, "Use a pure expression without assignment or update operators.");
  return transformIssue(`transform(...) callback syntax '${ts.SyntaxKind[node.kind]}' is not supported.`, node, "Use the supported pure expression subset or move the work into a Task.");
}

function transformObjectLiteralIssue(node: ts.ObjectLiteralExpression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  return firstIssue(node.properties, property => {
    if (ts.isPropertyAssignment(property)) {
      if (ts.isComputedPropertyName(property.name)) {
        const issue = transformExpressionIssue(property.name.expression, scope, checker);
        if (issue) return issue;
      }
      return transformExpressionIssue(property.initializer, scope, checker);
    }
    if (ts.isShorthandPropertyAssignment(property)) return scope.has(property.name.text) ? undefined : transformIssue(`transform(...) callback cannot reference '${property.name.text}'.`, property.name, "Use only the callback parameter.");
    return transformIssue("transform(...) callback object literals cannot use spread, methods, getters, or setters.", property, "Return explicit JSON object properties.");
  });
}

function transformBinaryIssue(node: ts.BinaryExpression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) return transformIssue("transform(...) callback cannot use comma expressions.", node, "Use a direct expression.");
  if (ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) return transformIssue("transform(...) callback cannot assign or mutate values.", node, "Use a pure expression without assignment.");
  return transformExpressionIssue(node.left, scope, checker) ?? transformExpressionIssue(node.right, scope, checker);
}

function transformCallIssue(node: ts.CallExpression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  if (isImportCall(node)) return transformIssue("transform(...) callback cannot import modules.", node, "Use a Task for dependency-backed work.");
  if (ts.isPropertyAccessExpression(node.expression)) {
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object") return objectCallIssue(node, scope, checker);
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Math") return mathCallIssue(node, scope, checker);
    const method = node.expression.name.text;
    if (!ALLOWED_TRANSFORM_METHODS.has(method)) {
      return transformIssue(`transform(...) callback cannot call method '${method}'.`, node.expression.name, "Use an allowlisted pure method or move the logic into a Task.");
    }
    return transformExpressionIssue(node.expression.expression, scope, checker) ?? transformCallArgsIssue(method, node.arguments, scope, checker);
  }
  return transformIssue("transform(...) callback can only call allowlisted methods and pure globals.", node.expression, "Use methods such as trim/includes/slice or Object.keys/Math.abs.");
}

function objectCallIssue(node: ts.CallExpression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  const access = node.expression as ts.PropertyAccessExpression;
  const name = access.name.text;
  if (!isGlobalIdentifier(access.expression as ts.Identifier, checker)) return transformIssue("transform(...) callback cannot shadow global Object.", access.expression, "Use the built-in Object global only.");
  if (!ALLOWED_OBJECT_CALLS.has(name)) return transformIssue(`transform(...) callback cannot call Object.${name}.`, node.expression, "Use Object.keys, Object.values, or Object.entries.");
  return transformCallArgsIssue(name, node.arguments, scope, checker);
}

function mathCallIssue(node: ts.CallExpression, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  const access = node.expression as ts.PropertyAccessExpression;
  const name = access.name.text;
  if (!isGlobalIdentifier(access.expression as ts.Identifier, checker)) return transformIssue("transform(...) callback cannot shadow global Math.", access.expression, "Use the built-in Math global only.");
  if (!ALLOWED_MATH_CALLS.has(name)) return transformIssue(`transform(...) callback cannot call Math.${name}.`, node.expression, "Use deterministic Math functions; Math.random is not allowed.");
  return transformCallArgsIssue(name, node.arguments, scope, checker);
}

function transformCallArgsIssue(method: string, args: ts.NodeArray<ts.Expression>, scope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  return firstIssue(args, arg => ts.isArrowFunction(arg) ? transformNestedArrowIssue(method, arg, scope, checker) : transformExpressionIssue(arg, scope, checker));
}

function transformNestedArrowIssue(method: string, node: ts.ArrowFunction, outerScope: ReadonlySet<string>, checker: ts.TypeChecker): TransformIssue | undefined {
  if (!CALLS_WITH_NESTED_CALLBACKS.has(method)) return transformIssue("transform(...) callback cannot pass function values here.", node, "Only array map/filter/some/every callbacks are supported.");
  const parameterName = plainArrowParameterName(node);
  if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !parameterName || ts.isBlock(node.body)) {
    return transformIssue("transform(...) nested callbacks must be one-expression arrows with one plain parameter.", node, "Use item => expression.");
  }
  const scope = new Set(outerScope);
  scope.add(parameterName);
  return transformExpressionIssue(node.body, scope, checker);
}

function plainArrowParameterName(node: ts.ArrowFunction): string | undefined {
  const parameter = node.parameters.length === 1 ? node.parameters[0] : undefined;
  return parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && !parameter.initializer ? parameter.name.text : undefined;
}

function transformIssue(message: string, node: ts.Node, hint: string): TransformIssue {
  return { message, node, hint };
}

function isGlobalIdentifier(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  const declarations = symbol.declarations ?? [];
  return declarations.length > 0 && declarations.every(declaration => isTypeScriptLibFile(declaration.getSourceFile().fileName));
}

function isTypeScriptLibFile(fileName: string): boolean {
  return /(?:^|[/\\])typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(fileName);
}

function isImportCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function firstIssue<T extends ts.Node>(items: Iterable<T>, check: (item: T) => TransformIssue | undefined): TransformIssue | undefined {
  for (const item of items) {
    const issue = check(item);
    if (issue) return issue;
  }
  return undefined;
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const ALLOWED_TRANSFORM_METHODS = new Set(["trim", "toLowerCase", "toUpperCase", "includes", "startsWith", "endsWith", "slice", "map", "filter", "some", "every", "join"]);
const CALLS_WITH_NESTED_CALLBACKS = new Set(["map", "filter", "some", "every"]);
const ALLOWED_OBJECT_CALLS = new Set(["keys", "values", "entries"]);
const ALLOWED_MATH_CALLS = new Set(["abs", "ceil", "floor", "round", "trunc", "max", "min", "pow", "sqrt"]);

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
