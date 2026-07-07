import type { DiagnosticIR } from "@acpus/core/ir";
import ts from "typescript";

type Producer = {
  label: string;
  expression: ts.Expression;
  type: ts.Type;
};

type RuleContext = {
  checker: ts.TypeChecker;
  diagnostics: DiagnosticIR[];
};

const NON_JSON_GLOBALS = new Set(["Date", "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet", "RegExp", "Promise", "Error"]);
const STEP_METHODS = new Set(["task", "if", "switch", "parallel", "fanout", "loop"]);

export function checkOutputAdmissibility(sourceFiles: ts.SourceFile | readonly ts.SourceFile[], checker: ts.TypeChecker): DiagnosticIR[] {
  const context: RuleContext = { checker, diagnostics: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      checkWorkflowBuild(node, context);
      checkTaskDefine(node, context);
      checkStepCall(node, context);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of Array.isArray(sourceFiles) ? sourceFiles : [sourceFiles]) visit(sourceFile);
  return context.diagnostics;
}

function checkWorkflowBuild(call: ts.CallExpression, context: RuleContext): void {
  if (!isPropertyCall(call, "build")) return;
  if (!isAcpusCoreResolvedCall(call, context.checker, "/graph/builder.")) return;
  const build = call.arguments[0];
  if (!build || !isFunctionLike(build)) return;
  const returns = returnExpressions(build);
  if (returns.length === 0) return;
  const producers: Producer[] = [];
  for (const expression of returns) {
    const object = objectOutputLiteral(expression);
    if (!object) {
      context.diagnostics.push(hiddenProducerDiagnostic("workflow root output", expression));
      continue;
    }
    producers.push({ label: "workflow root output", expression, type: context.checker.getTypeAtLocation(expression) });
  }
  checkProducers(producers, context);
  checkConvergence("workflow root outputs", producers, context);
}

function checkTaskDefine(call: ts.CallExpression, context: RuleContext): void {
  if (!isPropertyCall(call, "define")) return;
  if (!isAcpusCoreResolvedCall(call, context.checker, "/nodes/leaf/task.")) return;
  const spec = objectArg(call, 0, "task.define spec", context);
  if (!spec) return;
  const exec = propertyInitializer(spec, "exec");
  if (!exec || !isFunctionLike(exec)) {
    context.diagnostics.push(hiddenProducerDiagnostic("task.define exec", exec ?? spec));
    return;
  }
  checkFunctionOutput("task.define exec output", exec, context);
}

function checkStepCall(call: ts.CallExpression, context: RuleContext): void {
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  if (!STEP_METHODS.has(method)) return;
  if (!isAcpusStepCall(call, context.checker)) return;
  const spec = objectArg(call, 0, `${method} spec`, context);
  if (!spec) return;
  if (method === "task") checkInlineTask(spec, context);
  else if (method === "if") checkIf(spec, context);
  else if (method === "switch") checkSwitch(spec, context);
  else if (method === "parallel") checkParallel(spec, context);
  else if (method === "fanout") checkCallbackProperty(spec, "do", "fanout body output", context);
  else if (method === "loop") checkLoop(spec, context);
}

function checkInlineTask(spec: ts.ObjectLiteralExpression, context: RuleContext): void {
  const run = objectProperty(spec, "run", "task run", context);
  if (!run) return;
  const exec = propertyInitializer(run, "exec");
  if (exec !== undefined && !isFunctionLike(exec)) {
    context.diagnostics.push(hiddenProducerDiagnostic("inline task exec", exec));
    return;
  }
  if (exec) checkFunctionOutput("inline task output", exec, context);
  else checkReusableTaskOutput(run, context);
}

function checkIf(spec: ts.ObjectLiteralExpression, context: RuleContext): void {
  const producers = [
    callbackProducer(spec, "then", "if then output", context),
    callbackProducer(spec, "else", "if else output", context),
  ].filter((producer): producer is Producer => Boolean(producer));
  checkProducers(producers, context);
  checkConvergence("if branch outputs", producers, context);
}

function checkSwitch(spec: ts.ObjectLiteralExpression, context: RuleContext): void {
  const cases = propertyInitializer(spec, "cases");
  const producers: Producer[] = [];
  if (!cases || !ts.isArrayLiteralExpression(cases)) {
    context.diagnostics.push(hiddenProducerDiagnostic("switch cases", cases ?? spec));
  } else {
    cases.elements.forEach((element, index) => {
      if (!ts.isObjectLiteralExpression(element)) {
        context.diagnostics.push(hiddenProducerDiagnostic(`switch case ${index}`, element));
        return;
      }
      const producer = callbackProducer(element, "then", `switch case ${index} output`, context);
      if (producer) producers.push(producer);
    });
  }
  const defaultProducer = callbackProducer(spec, "default", "switch default output", context);
  if (defaultProducer) producers.push(defaultProducer);
  checkProducers(producers, context);
  checkConvergence("switch branch outputs", producers, context);
}

function checkParallel(spec: ts.ObjectLiteralExpression, context: RuleContext): void {
  const branches = objectProperty(spec, "branches", "parallel branches", context);
  if (!branches) return;
  const producers: Producer[] = [];
  for (const branch of branches.properties) {
    if (!ts.isPropertyAssignment(branch) || !ts.isObjectLiteralExpression(branch.initializer)) {
      context.diagnostics.push(hiddenProducerDiagnostic("parallel branch", branch));
      continue;
    }
    const name = propertyName(branch.name) ?? "branch";
    const producer = callbackProducer(branch.initializer, "do", `parallel branch '${name}' output`, context);
    if (producer) producers.push(producer);
  }
  checkProducers(producers, context);
  if (literalStringProperty(spec, "strategy") === "race") checkConvergence("parallel race branch outputs", producers, context);
}

function checkLoop(spec: ts.ObjectLiteralExpression, context: RuleContext): void {
  const initial = propertyInitializer(spec, "initial");
  const body = callbackProducer(spec, "do", "loop body output", context);
  let initialProducer: Producer | undefined;
  if (initial) {
    const initialType = context.checker.getTypeAtLocation(initial);
    initialProducer = { label: "loop initial output", expression: initial, type: initialType };
    if (!objectOutputLiteral(initial)) {
      context.diagnostics.push(hiddenProducerDiagnostic("loop initial output", initial));
    }
    checkProducer(initialProducer, context);
    checkObjectOutputType("loop initial output", initialType, initial, context);
  }
  else context.diagnostics.push(hiddenProducerDiagnostic("loop initial output", spec));
  if (body) {
    checkProducer(body, context);
    if (initialProducer) checkConvergence("loop initial and body outputs", [initialProducer, body], context);
  }
  const maxIterations = propertyInitializer(spec, "maxIterations");
  if (maxIterations && numericLiteralValue(maxIterations) !== undefined && numericLiteralValue(maxIterations)! < 0) {
    context.diagnostics.push({
      code: "OA004",
      severity: "error",
      message: "Loop maxIterations must be non-negative.",
      path: "output.loop.maxIterations",
      hint: "Use 0 or a positive integer. The initial value is checked before any loop body execution.",
      source: sourceLocation(maxIterations),
    });
  }
}

function checkCallbackProperty(spec: ts.ObjectLiteralExpression, key: string, label: string, context: RuleContext): void {
  const producer = callbackProducer(spec, key, label, context);
  if (producer) checkProducer(producer, context);
}

function callbackProducer(spec: ts.ObjectLiteralExpression, key: string, label: string, context: RuleContext): Producer | undefined {
  const value = propertyInitializer(spec, key);
  if (!value || !isFunctionLike(value)) {
    context.diagnostics.push(hiddenProducerDiagnostic(label, value ?? spec));
    return undefined;
  }
  const returns = returnExpressions(value);
  if (returns.length !== 1) {
    context.diagnostics.push(hiddenProducerDiagnostic(label, value));
    return undefined;
  }
  const expression = returns[0]!;
  if (!objectOutputLiteral(expression)) {
    context.diagnostics.push(hiddenProducerDiagnostic(label, expression));
    return undefined;
  }
  return { label, expression, type: context.checker.getTypeAtLocation(expression) };
}

function checkFunctionOutput(label: string, fn: ts.FunctionLikeDeclaration | ts.ArrowFunction, context: RuleContext): void {
  const signature = context.checker.getSignatureFromDeclaration(fn);
  if (!signature) return;
  const returnType = context.checker.getReturnTypeOfSignature(signature);
  const awaited = context.checker.getAwaitedType(returnType) ?? returnType;
  checkProducer({ label, expression: fn as ts.Expression, type: awaited }, context);
}

function checkReusableTaskOutput(run: ts.ObjectLiteralExpression, context: RuleContext): void {
  const task = propertyInitializer(run, "task");
  if (!task) return;
  const fn = context.checker.getTypeAtLocation(task).getProperty("fn");
  if (!fn) {
    context.diagnostics.push(hiddenProducerDiagnostic("reusable task output", task));
    return;
  }
  const fnType = context.checker.getTypeOfSymbolAtLocation(fn, task);
  const signature = fnType.getCallSignatures()[0];
  if (!signature) {
    context.diagnostics.push(hiddenProducerDiagnostic("reusable task output", task));
    return;
  }
  const returnType = context.checker.getReturnTypeOfSignature(signature);
  const awaited = context.checker.getAwaitedType(returnType) ?? returnType;
  checkProducer({ label: "reusable task output", expression: task, type: awaited }, context);
}

function checkProducers(producers: Producer[], context: RuleContext): void {
  for (const producer of producers) checkProducer(producer, context);
}

function checkProducer(producer: Producer, context: RuleContext): void {
  const issue = admissibilityIssue(producer.type, producer.expression, context.checker, new Set());
  if (!issue) return;
  context.diagnostics.push({
    code: "OA002",
    severity: "error",
    message: `${producer.label} contains non-admissible workflow data: ${issue}.`,
    path: "output.admissibility",
    hint: "Return JSON-compatible data, Expr<T> values whose T is JSON-compatible, undefined for local absence, or explicit JsonValue/JsonObject opaque values.",
    source: sourceLocation(producer.expression),
  });
}

function checkConvergence(label: string, producers: Producer[], context: RuleContext): void {
  if (producers.length < 2) return;
  const base = producers[0]!;
  const baseShape = outputShape(base.type, base.expression, context.checker);
  if (!baseShape) return;
  for (const producer of producers.slice(1)) {
    const shape = outputShape(producer.type, producer.expression, context.checker);
    if (!shape) continue;
    const baseKeys = [...baseShape.keys()].sort();
    const keys = [...shape.keys()].sort();
    if (baseKeys.join("\0") !== keys.join("\0")) {
      context.diagnostics.push(convergenceDiagnostic(label, producer.expression, `branches must return the same keys; expected ${baseKeys.join(", ") || "(none)"}, got ${keys.join(", ") || "(none)"}`));
      continue;
    }
    for (const key of baseKeys) {
      const left = baseShape.get(key)!;
      const right = shape.get(key)!;
      if (!context.checker.isTypeAssignableTo(left, right) && !context.checker.isTypeAssignableTo(right, left)) {
        context.diagnostics.push(convergenceDiagnostic(label, producer.expression, `field '${key}' does not converge`));
      }
    }
  }
}

function checkObjectOutputType(label: string, type: ts.Type, node: ts.Node, context: RuleContext): void {
  const unwrapped = unwrapExpr(type, node, context.checker);
  if (isKnownJsonObjectAlias(unwrapped)) return;
  if (unwrapped.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  if (unwrapped.isUnionOrIntersection() || context.checker.isArrayType(unwrapped) || context.checker.isTupleType(unwrapped)) {
    context.diagnostics.push(convergenceDiagnostic(label, node, "must be an object, not a union or array"));
    return;
  }
  if (unwrapped.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void)) {
    context.diagnostics.push(convergenceDiagnostic(label, node, "must be an object"));
    return;
  }
  if (context.checker.typeToString(unwrapped) === "object") {
    context.diagnostics.push(convergenceDiagnostic(label, node, "must be a statically known object"));
  }
}

function outputShape(type: ts.Type, node: ts.Node, checker: ts.TypeChecker): Map<string, ts.Type> | undefined {
  const unwrapped = unwrapExpr(type, node, checker);
  if (unwrapped.isUnion()) return undefined;
  const properties = checker.getPropertiesOfType(unwrapped);
  const shape = new Map<string, ts.Type>();
  for (const property of properties) {
    if (property.name === "__ir" || property.name === "__type") continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
    shape.set(property.name, unwrapExpr(checker.getTypeOfSymbolAtLocation(property, declaration), declaration, checker));
  }
  return shape;
}

function admissibilityIssue(type: ts.Type, node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Type>): string | undefined {
  const unwrapped = unwrapExpr(type, node, checker);
  if (seen.has(unwrapped)) return undefined;
  seen.add(unwrapped);
  if (isKnownJsonAlias(unwrapped)) return undefined;
  if (unwrapped.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
  if (unwrapped.flags & ts.TypeFlags.Never) return undefined;
  if (unwrapped.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return undefined;
  if (unwrapped.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (unwrapped.flags & ts.TypeFlags.ESSymbolLike) return "symbol";
  if (unwrapped.isUnionOrIntersection()) {
    for (const part of unwrapped.types) {
      const issue = admissibilityIssue(part, node, checker, seen);
      if (issue) return issue;
    }
    return undefined;
  }
  if (checker.isArrayType(unwrapped) || checker.isTupleType(unwrapped)) {
    const item = checker.getIndexTypeOfType(unwrapped, ts.IndexKind.Number);
    return item ? admissibilityIssue(item, node, checker, seen) : undefined;
  }
  if (unwrapped.getCallSignatures().length > 0) return "function";
  if (unwrapped.getConstructSignatures().length > 0) return "class constructor";
  const symbol = unwrapped.getSymbol() ?? unwrapped.aliasSymbol;
  const symbolName = symbol?.getName();
  if (symbolName && NON_JSON_GLOBALS.has(symbolName)) return symbolName;
  if (symbol?.declarations?.some(declaration => ts.isClassDeclaration(declaration))) return "class instance";
  const typeText = checker.typeToString(unwrapped);
  if (typeText === "object" || typeText === "Object" || (typeText === "{}" && !ts.isObjectLiteralExpression(node))) return typeText;
  const stringIndex = checker.getIndexTypeOfType(unwrapped, ts.IndexKind.String);
  if (stringIndex) {
    const issue = admissibilityIssue(stringIndex, node, checker, seen);
    if (issue) return issue;
  }
  const properties = checker.getPropertiesOfType(unwrapped);
  for (const property of properties) {
    if (property.name === "__ir" || property.name === "__type") continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
    if (property.flags & ts.SymbolFlags.Method) return `method '${property.name}'`;
    const issue = admissibilityIssue(checker.getTypeOfSymbolAtLocation(property, declaration), declaration, checker, seen);
    if (issue) return `${property.name}: ${issue}`;
  }
  return undefined;
}

function unwrapExpr(type: ts.Type, node: ts.Node, checker: ts.TypeChecker): ts.Type {
  const typeProperty = type.getProperty("__type");
  return typeProperty && type.getProperty("__ir")
    ? checker.getTypeOfSymbolAtLocation(typeProperty, typeProperty.valueDeclaration ?? node)
    : type;
}

function isKnownJsonAlias(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol || (symbol.getName() !== "JsonValue" && symbol.getName() !== "JsonObject")) return false;
  return isAcpusJsonDeclaration(symbol);
}

function isKnownJsonObjectAlias(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return Boolean(symbol && symbol.getName() === "JsonObject" && isAcpusJsonDeclaration(symbol));
}

function isAcpusJsonDeclaration(symbol: ts.Symbol): boolean {
  return Boolean(symbol.declarations?.some(declaration => /packages\/(expression|core)\/(src|dist)\/(ir|ir\/types)(\.d)?\.ts$/.test(declaration.getSourceFile().fileName.replace(/\\/g, "/"))));
}

function returnExpressions(fn: ts.FunctionLikeDeclaration | ts.ArrowFunction): ts.Expression[] {
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const returns: ts.Expression[] = [];
  if (!fn.body || !ts.isBlock(fn.body)) return returns;
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return returns;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function objectOutputLiteral(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const object = unwrapParentheses(expression);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || ts.isPropertyAssignment(property) && propertyName(property.name) === undefined) return undefined;
  }
  return object;
}

function objectArg(call: ts.CallExpression, index: number, label: string, context: RuleContext): ts.ObjectLiteralExpression | undefined {
  const arg = call.arguments[index];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    context.diagnostics.push(hiddenProducerDiagnostic(label, arg ?? call));
    return undefined;
  }
  if (arg.properties.some(ts.isSpreadAssignment)) context.diagnostics.push(hiddenProducerDiagnostic(label, arg));
  return arg;
}

function objectProperty(parent: ts.ObjectLiteralExpression, key: string, label: string, context: RuleContext): ts.ObjectLiteralExpression | undefined {
  const initializer = propertyInitializer(parent, key);
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    context.diagnostics.push(hiddenProducerDiagnostic(label, initializer ?? parent));
    return undefined;
  }
  if (initializer.properties.some(ts.isSpreadAssignment)) context.diagnostics.push(hiddenProducerDiagnostic(label, initializer));
  return initializer;
}

function propertyInitializer(parent: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of parent.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyName(property.name) === key) return property.initializer;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalStringProperty(parent: ts.ObjectLiteralExpression, key: string): string | undefined {
  const initializer = propertyInitializer(parent, key);
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function numericLiteralValue(expression: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
    const value = Number(expression.operand.text);
    if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expression.operator === ts.SyntaxKind.PlusToken) return value;
  }
  return undefined;
}

function isAcpusStepCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (isAcpusCoreResolvedCall(call, checker, "/graph/builder.")) return true;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  return hasStepDeclarationType(checker.getTypeAtLocation(call.expression.expression));
}

function hasStepDeclarationType(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(hasStepDeclarationType);
  const symbol = type.aliasSymbol ?? (typeof type.getSymbol === "function" ? type.getSymbol() : undefined);
  return symbolName(symbol) === "StepDeclaration" && isAcpusCoreSymbol(symbol);
}

function symbolName(symbol: ts.Symbol | undefined): string | undefined {
  if (!symbol) return undefined;
  return typeof symbol.getName === "function" ? symbol.getName() : (symbol as { name?: string }).name;
}

function isPropertyCall(call: ts.CallExpression, name: string): call is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === name;
}

function isAcpusCoreResolvedCall(call: ts.CallExpression, checker: ts.TypeChecker, filePattern: string): boolean {
  if (typeof checker.getResolvedSignature !== "function") return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return Boolean(declaration && sourceFileName(declaration).includes(filePattern) && isAcpusCoreFile(sourceFileName(declaration)));
}

function isAcpusCoreSymbol(symbol: ts.Symbol | undefined): boolean {
  return Boolean(symbol?.declarations?.some(declaration => isAcpusCoreFile(sourceFileName(declaration))));
}

function sourceFileName(node: ts.Node): string {
  return node.getSourceFile().fileName.replace(/\\/g, "/");
}

function isAcpusCoreFile(fileName: string): boolean {
  return /(^|\/)(packages\/core\/(src|dist)|node_modules\/@acpus\/core)\//.test(fileName);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration | ts.ArrowFunction {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node);
}

function hiddenProducerDiagnostic(label: string, node: ts.Node): DiagnosticIR {
  return {
    code: "OA001",
    severity: "error",
    message: `Cannot statically locate ${label}.`,
    path: "output.source",
    hint: "Inline the workflow spec and producer callback as object/function literals so Acpus can check inferred output before runtime.",
    source: sourceLocation(node),
  };
}

function convergenceDiagnostic(label: string, node: ts.Node, reason: string): DiagnosticIR {
  return {
    code: "OA003",
    severity: "error",
    message: `${label} do not converge: ${reason}.`,
    path: "output.convergence",
    hint: "Return the same object keys from every branch and make each field type share a common assignable type.",
    source: sourceLocation(node),
  };
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
