import type { DiagnosticIR } from "@acpus/core/ir";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkWorkflowAuthoring } from "../src/check/authoring-rules/index.js";
import type { TaskAuthoringIssue, WorkflowTaskAnalysis } from "../src/task-analysis/index.js";

describe("workflow authoring rules", () => {
  it("reports Expr authoring diagnostics without running the full check pipeline", () => {
    const diagnostics = checkAuthoring(`
      declare const expr: unknown;
      declare const items: unknown[];
      declare const step: any;
      if (expr) {}
      const negated = !expr;
      const logical = expr && true;
      const compared = expr > 1;
      const prompt = \`\${expr}\`;
      const mapped = items.map((item) => item);
      step(expr).assert({ condition: true });
      void [negated, logical, compared, prompt, mapped];
    `, {
      isExpr: node => ts.isIdentifier(node) && (node.text === "expr" || node.text === "items"),
    });

    expect(codes(diagnostics)).toEqual(expect.arrayContaining([
      "AL001",
      "AL002",
      "AL003",
      "AL004",
      "AL005",
      "AL006",
    ]));
    expect(diagnostics.filter(diagnostic => diagnostic.code.startsWith("AL"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ file: "workflow.ts" }),
          hint: expect.any(String),
        }),
      ]),
    );
  });

  it("reports reason-specific TB008 diagnostics for unjoinable task callsites", () => {
    const diagnostics = checkAuthoring(`
      declare const step: any;
      declare const dynamic: string;
      declare const spec: object;
      declare const s: any;
      step(dynamic).task({});
      step("non_object").task(spec);
      const saved = step("saved");
      saved.task({});
      s("aliased").task({});
    `, {
      isStepDeclaration: node =>
        (ts.isIdentifier(node) && node.text === "saved")
        || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "s"),
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TB008", hint: expect.stringContaining("literal task step id") }),
      expect.objectContaining({ code: "TB008", hint: expect.stringContaining("object literal") }),
      expect.objectContaining({ code: "TB008", hint: expect.stringContaining('step("id").task') }),
    ]));
  });

  it("maps task-analysis issues to task-authoring diagnostics", () => {
    const diagnostics = checkAuthoring("", {
      taskAnalysis: new Map([
        ["local", analyzedIssue({ kind: "workflow-local-reusable-task", name: "localTask" })],
        ["invalid_export", analyzedIssue({ kind: "invalid-reusable-task-export", importedName: "default", reason: "not-task-define" })],
        ["inline_capture", analyzedIssue({ kind: "inline-task-capture", names: ["PREFIX"] })],
        ["duplicate", analyzedIssue({ kind: "ambiguous-task-callsite" })],
      ]),
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TB004", path: "tasks.local.reference", hint: expect.any(String) }),
      expect.objectContaining({ code: "TB005", path: "tasks.invalid_export.reference", hint: expect.any(String) }),
      expect.objectContaining({ code: "TB007", path: "tasks.inline_capture.source", hint: expect.any(String) }),
      expect.objectContaining({ code: "TB008", path: "tasks.duplicate.reference", hint: expect.stringContaining("unique task step ids") }),
    ]));
  });
});

function checkAuthoring(source: string, options: {
  isExpr?: (node: ts.Node) => boolean;
  isStepDeclaration?: (node: ts.Node) => boolean;
  taskAnalysis?: WorkflowTaskAnalysis;
} = {}): DiagnosticIR[] {
  const sourceFile = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return checkWorkflowAuthoring({
    program: fakeProgram(options),
    sourceFile,
    taskAnalysis: options.taskAnalysis ?? new Map(),
  });
}

function fakeProgram(options: {
  isExpr?: (node: ts.Node) => boolean;
  isStepDeclaration?: (node: ts.Node) => boolean;
}): ts.Program {
  const checker = {
    getTypeAtLocation(node: ts.Node) {
      return fakeType({
        expr: options.isExpr?.(node) ?? false,
        stepDeclaration: options.isStepDeclaration?.(node) ?? false,
      });
    },
  };
  return { getTypeChecker: () => checker } as unknown as ts.Program;
}

function fakeType(flags: { expr: boolean; stepDeclaration: boolean }): ts.Type {
  return {
    isUnionOrIntersection: () => false,
    getProperty: (name: string) => flags.expr && name === "__ir" ? {} : undefined,
    ...(flags.stepDeclaration ? { aliasSymbol: { name: "StepDeclaration" } } : {}),
  } as unknown as ts.Type;
}

function analyzedIssue(issue: TaskAuthoringIssue): WorkflowTaskAnalysis extends Map<string, infer Value> ? Value : never {
  return {
    inline: false,
    issue,
    source: { file: "workflow.ts", line: 1, column: 1 },
  } as WorkflowTaskAnalysis extends Map<string, infer Value> ? Value : never;
}

function codes(diagnostics: DiagnosticIR[]): string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}
