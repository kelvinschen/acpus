import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// Static provenance gate for task assets. It parses the workflow module (and the
// task modules it imports) with the TypeScript parser only — no Program, no
// TypeChecker — and decides, per `step("id").task({...})` callsite, whether the
// task is admissible. The compile flow joins these results to IR task nodes by
// step id and turns errors into bundle diagnostics. The CLI typechecks the
// workflow before compile, so we may treat "any name declared inside the exec
// subtree" as the declared set without a full scope walker.

export type AnalyzedTask = {
  inline: boolean;
  sourceFile?: string;
  error?: TaskProvenanceError;
};

export type TaskProvenanceError = {
  code: string;
  message: string;
  pathSuffix: string;
};

export type WorkflowTaskAnalysis = Map<string, AnalyzedTask>;

const GLOBALS = new Set<string>([
  ...Object.getOwnPropertyNames(globalThis),
  "arguments",
]);

export async function analyzeWorkflowTasks(workflowFile: string, source: string): Promise<WorkflowTaskAnalysis> {
  const sourceFile = parse(workflowFile, source);
  const imports = collectImportBindings(sourceFile);
  const locals = collectLocalValueNames(sourceFile);
  const analysis: WorkflowTaskAnalysis = new Map();
  for (const callsite of findTaskCallsites(sourceFile)) {
    analysis.set(callsite.stepId, await analyzeCallsite(callsite, { workflowFile, imports, locals }));
  }
  return analysis;
}

type TaskCallsite = {
  stepId: string;
  options: ts.ObjectLiteralExpression;
};

type AnalyzeContext = {
  workflowFile: string;
  imports: Map<string, ImportBinding>;
  locals: Set<string>;
};

type ImportBinding = { specifier: string; importedName: string };

async function analyzeCallsite(callsite: TaskCallsite, ctx: AnalyzeContext): Promise<AnalyzedTask> {
  const taskValue = property(callsite.options, "task");
  if (taskValue) return analyzeReusable(taskValue, ctx);
  const exec = execFunction(callsite.options);
  if (exec) return analyzeInline(exec);
  return { inline: true };
}

async function analyzeReusable(taskValue: ts.Expression, ctx: AnalyzeContext): Promise<AnalyzedTask> {
  if (!ts.isIdentifier(taskValue)) {
    return reusableError("TB005", "Reusable task must reference a directly imported task.define(...) module export.");
  }
  const name = taskValue.text;
  if (ctx.locals.has(name) && !ctx.imports.has(name)) {
    return reusableError("TB004", `Reusable task '${name}' must be defined in an exported task module, not as a workflow-local value.`);
  }
  const binding = ctx.imports.get(name);
  if (!binding) {
    return reusableError("TB005", `Reusable task '${name}' must reference a directly imported task.define(...) module export.`);
  }
  if (!binding.specifier.startsWith(".")) {
    return reusableError("TB006", `Reusable task '${name}' must be imported from a relative task module, not '${binding.specifier}'.`);
  }
  const targetFile = await resolveImportFile(binding.specifier, ctx.workflowFile);
  if (!targetFile) {
    return reusableError("TB006", `Reusable task '${name}' import '${binding.specifier}' could not be resolved to a task module file.`);
  }
  const verdict = await verifyTaskModuleExport(targetFile, binding.importedName);
  if (!verdict.ok) return reusableError(verdict.code, verdict.message);
  return { inline: false, sourceFile: targetFile };
}

function analyzeInline(exec: ts.FunctionLikeDeclarationBase): AnalyzedTask {
  const free = collectFreeIdentifiers(exec);
  if (free.length > 0) {
    return {
      inline: true,
      error: {
        code: "TB007",
        message: `Inline task is not self-contained; it references ${free.map(name => `'${name}'`).join(", ")}. Move shared logic into a reusable task.define(...) module.`,
        pathSuffix: ".source",
      },
    };
  }
  return { inline: true };
}

function reusableError(code: string, message: string): AnalyzedTask {
  return { inline: false, error: { code, message, pathSuffix: ".sourceFile" } };
}

// --- Workflow AST scanning -------------------------------------------------

function findTaskCallsites(sourceFile: ts.SourceFile): TaskCallsite[] {
  const callsites: TaskCallsite[] = [];
  const visit = (node: ts.Node): void => {
    const callsite = matchTaskCallsite(node);
    if (callsite) callsites.push(callsite);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callsites;
}

function matchTaskCallsite(node: ts.Node): TaskCallsite | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "task") return undefined;
  const stepCall = callee.expression;
  if (!ts.isCallExpression(stepCall) || !ts.isIdentifier(stepCall.expression) || stepCall.expression.text !== "step") return undefined;
  const idArg = stepCall.arguments[0];
  if (!idArg || !ts.isStringLiteral(idArg)) return undefined;
  const options = node.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return { stepId: idArg.text, options };
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
  }
  return undefined;
}

function execFunction(options: ts.ObjectLiteralExpression): ts.FunctionLikeDeclarationBase | undefined {
  const run = property(options, "run");
  if (!run || !ts.isObjectLiteralExpression(run)) return undefined;
  const exec = property(run, "exec");
  if (exec && (ts.isArrowFunction(exec) || ts.isFunctionExpression(exec))) return exec;
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function collectImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { specifier, importedName: "default" });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, { specifier, importedName: (element.propertyName ?? element.name).text });
      }
    }
  }
  return bindings;
}

function collectLocalValueNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingName(declaration.name, names);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names;
}

// --- Task module verification ----------------------------------------------

type ExportVerdict = { ok: true } | { ok: false; code: string; message: string };

async function verifyTaskModuleExport(file: string, importedName: string): Promise<ExportVerdict> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, code: "TB006", message: `Task module ${file} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const sourceFile = parse(file, source);
  const taskFactory = taskFactoryLocalName(sourceFile);
  const locals = collectLocalInitializers(sourceFile);
  const target = importedName === "default"
    ? resolveDefaultExport(sourceFile)
    : resolveNamedExport(sourceFile, importedName);
  if (!target.ok) return target;
  const initializer = ts.isIdentifier(target.expression)
    ? locals.get(target.expression.text)
    : target.expression;
  if (!initializer || !isTaskDefineCall(initializer, taskFactory)) {
    return { ok: false, code: "TB005", message: `Task module export '${importedName}' in ${file} must be initialized with task.define(...).` };
  }
  return { ok: true };
}

type ExportTarget = { ok: true; expression: ts.Expression } | { ok: false; code: string; message: string };

function resolveDefaultExport(sourceFile: ts.SourceFile): ExportTarget {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return { ok: true, expression: statement.expression };
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      return barrel(statement.moduleSpecifier);
    }
  }
  return { ok: false, code: "TB005", message: "Task module is missing a default task.define(...) export." };
}

function resolveNamedExport(sourceFile: ts.SourceFile, name: string): ExportTarget {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          return { ok: true, expression: declaration.initializer };
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        if (statement.moduleSpecifier) return barrel(statement.moduleSpecifier);
        const local = (element.propertyName ?? element.name).text;
        return { ok: true, expression: ts.factory.createIdentifier(local) };
      }
    }
  }
  return { ok: false, code: "TB005", message: `Task module is missing a named export '${name}'.` };
}

function barrel(moduleSpecifier: ts.Expression): ExportTarget {
  const specifier = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "<module>";
  return { ok: false, code: "TB006", message: `Reusable task must be imported directly, not re-exported through '${specifier}'.` };
}

function collectLocalInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}

function taskFactoryLocalName(sourceFile: ts.SourceFile): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "@acpus/core") continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if ((element.propertyName ?? element.name).text === "task") return element.name.text;
      }
    }
  }
  return undefined;
}

function isTaskDefineCall(expression: ts.Expression, taskFactory: string | undefined): boolean {
  if (!taskFactory || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  return ts.isPropertyAccessExpression(callee)
    && callee.name.text === "define"
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === taskFactory;
}

function isExported(node: ts.VariableStatement): boolean {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

// --- Inline free-variable analysis -----------------------------------------

function collectFreeIdentifiers(fn: ts.FunctionLikeDeclarationBase): string[] {
  const declared = new Set<string>();
  collectDeclaredNames(fn, declared);
  const referenced = new Set<string>();
  collectReferences(fn, referenced);
  return [...referenced].filter(name => !declared.has(name) && !GLOBALS.has(name)).sort();
}

function collectDeclaredNames(node: ts.Node, out: Set<string>): void {
  if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    addBindingName(node.name, out);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    out.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    addBindingName(node.variableDeclaration.name, out);
  }
  ts.forEachChild(node, child => collectDeclaredNames(child, out));
}

function addBindingName(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingName(element.name, out);
  }
}

function collectReferences(node: ts.Node, out: Set<string>): void {
  if (ts.isTypeNode(node)) return;
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
    out.add(node.name.text);
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
    out.add(node.text);
    return;
  }
  ts.forEachChild(node, child => collectReferences(child, out));
}

// --- Parsing and module resolution -----------------------------------------

function parse(file: string, source: string): ts.SourceFile {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
}

async function resolveImportFile(specifier: string, fromFile: string): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  const candidates: string[] = [];
  const tsExtensions = [".ts", ".mts", ".cts", ".tsx"];
  const jsMatch = base.match(/\.(js|mjs|cjs)$/);
  if (jsMatch) {
    for (const extension of tsExtensions) candidates.push(base.replace(/\.(js|mjs|cjs)$/, extension));
  }
  candidates.push(base);
  for (const extension of [...tsExtensions, ".js", ".mjs", ".cjs"]) candidates.push(`${base}${extension}`);
  for (const extension of [...tsExtensions, ".js", ".mjs", ".cjs"]) candidates.push(`${base}/index${extension}`);
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
