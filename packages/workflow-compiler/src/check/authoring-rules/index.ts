import type { DiagnosticIR } from "@acpus/core/ir";
import ts from "typescript";
import { type TaskCallsiteIssueReason, unjoinableTaskCallsiteReason } from "../../task-analysis/callsites.js";
import { analyzeTaskAuthoring, type TaskAuthoringIssue, type WorkflowTaskAnalysis } from "../../task-analysis/index.js";
import { checkOutputAdmissibility } from "./output-admissibility.js";

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
  if (typeof program.getSourceFiles !== "function") return [entry];
  return program.getSourceFiles().filter(sourceFile => {
    if (sourceFile.isDeclarationFile) return false;
    if (sourceFile.fileName === entry.fileName) return true;
    const fileName = sourceFile.fileName.replace(/\\/g, "/");
    if (fileName.includes("/node_modules/")) return false;
    if (fileName.includes("/packages/core/src/") || fileName.includes("/packages/expression/src/")) return false;
    return true;
  });
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
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
