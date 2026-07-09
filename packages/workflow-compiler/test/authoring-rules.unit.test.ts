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

  it("allows expression array index projection but rejects array methods", () => {
    const diagnostics = checkAuthoring(`
      declare const items: unknown[];
      const first = items[0];
      const mapped = items.map(item => item);
      void [first, mapped];
    `, {
      isExpr: node => ts.isIdentifier(node) && node.text === "items",
    });

    const methodDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL005");
    expect(methodDiagnostics).toHaveLength(1);
    expect(methodDiagnostics[0]?.message).toContain("array methods");
  });

  it("reports shadowed runtime globals captured by inline tasks", () => {
    const diagnostics = checkAuthoringWithProgram(`
      export {};
      const Math = { max: (..._values: number[]) => 1 };
      declare const step: any;
      step("inline").task({
        run: {
          exec: async () => ({ value: Math.max(1, 2) }),
        },
      });
    `);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "TB007",
      message: expect.stringContaining("'Math'"),
      path: "tasks.inline.source",
    }));
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

  it("accepts pure one-expression fmap and lift callbacks from the expression facade", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap, lift2, lift3, lift as namedLift } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[] };
      declare const count: number;
      declare const limit: number;
      const title = fmap(issue, value => value.title.trim());
      const overLimit = lift2(count, limit, (value, max) => value > max);
      const routed = lift3(issue.title, count, limit, (title, value, max) => title.length + value > max);
      const named = namedLift({ issue, count, limit }, ({ issue, count, limit }) => ({
        title: issue.title.trim().replace(/\\s+/g, " "),
        urgent: issue.labels.includes("urgent"),
        labels: issue.labels.map(label => label.toLowerCase()),
        count: Math.max(Object.keys(issue).length, count, limit),
        serialized: JSON.stringify(issue),
        now: Date.now(),
        random: Math.random(),
      }));
      const view = expr.fmap(issue, value => ({
        title: value.title.trim(),
        urgent: value.labels.includes("urgent"),
        labels: value.labels.map(label => label.toLowerCase()),
        count: Math.max(Object.keys(value).length, 1),
      }));
      void [title, overLimit, routed, named, view];
    `);

    expect(codes(diagnostics)).not.toContain("AL007");
  });

  it.each([
    ["missing callback", "fmap(issue)", "requires an inline callback"],
    ["block body", "fmap(issue, value => { return value.title; })", "one expression"],
    ["function expression", "fmap(issue, function (value) { return value.title; })", "inline one-expression arrow"],
    ["wrong fmap arity", "fmap(issue, () => \"title\")", "simple identifiers or binding patterns"],
    ["wrong lift2 arity", "lift2(issue, issue, value => value.title)", "simple identifiers or binding patterns"],
    ["wrong lift3 arity", "lift3(issue, issue, issue, (a, b) => a.title + b.title)", "simple identifiers or binding patterns"],
    ["wrong lift arity", "lift({ issue }, () => \"title\")", "simple identifiers or binding patterns"],
    ["helper reference", "fmap(issue, helper)", "inline one-expression arrow"],
    ["capture", "fmap(issue, value => value.title + suffix)", "external binding 'suffix'"],
    ["this", "fmap(issue, value => this)", "cannot use this"],
    ["shadowed Math", "const Math = { max: (..._values: number[]) => 1 }; fmap(issue, value => Math.max(value.count, 1))", "external binding 'Math'"],
    ["shadowed JSON", "const JSON = { stringify: (_value: unknown) => \"{}\" }; fmap(issue, value => JSON.stringify(value))", "external binding 'JSON'"],
    ["shadowed Date", "const Date = { now: () => 0 }; fmap(issue, value => Date.now() + value.count)", "external binding 'Date'"],
    ["aliased import capture", "combine(issue, issue, (left, right) => left.title + right.title + suffix)", "external binding 'suffix'"],
    ["nested block callback", "fmap(issue, value => value.labels.map(label => { return label.trim(); }))", "nested callbacks"],
    ["nested default parameter", "fmap(issue, value => value.labels.map((label = suffix) => label))", "nested callback parameters"],
    ["nested rest parameter", "fmap(issue, value => value.labels.map((...label) => label[0]))", "nested callback parameters"],
    ["nested capture", "fmap(issue, value => value.labels.map(label => label + suffix))", "external binding 'suffix'"],
  ])("rejects expression callback %s", (_name, statement, message) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap, lift2, lift3, lift, lift2 as combine } from "acpus/expression";

      declare const issue: any;
      declare const helper: (value: unknown) => unknown;
      const suffix = "!";
      ${statement};
    `);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL007");
    expect(callbackDiagnostics).toHaveLength(1);
    expect(callbackDiagnostics[0]!.message).toContain(message);
    expect(callbackDiagnostics[0]).toMatchObject({
      hint: expect.any(String),
      source: { file: "workflow.ts" },
    });
  });

  it("does not report expression callback diagnostics for shadowed facade bindings", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: any;
      {
        const fmap = (_value: unknown, _fn: unknown) => null;
        fmap(issue, value => { return value.title; });
      }
      function run(expr: { fmap: (value: unknown, fn: unknown) => unknown }) {
        expr.fmap(issue, value => { return value.title; });
      }
      void [fmap, expr, run];
    `);

    expect(codes(diagnostics)).not.toContain("AL007");
  });

  it.each([
    ["Date", "fmap(issue, (value: { when: Date }) => value.when)", "Date"],
    ["function", "fmap(issue, (value: { fn: () => boolean }) => value.fn)", "function"],
    ["Promise", "fmap(issue, (value: { promise: Promise<number> }) => value.promise)", "Promise"],
    ["class instance", "fmap(issue, (value: { view: View }) => value.view)", "class instance"],
    ["Map", "fmap(issue, (value: { values: Map<string, number> }) => value.values)", "Map"],
    ["Set", "fmap(issue, (value: { values: Set<string> }) => value.values)", "Set"],
    ["symbol", "fmap(issue, (value: { token: symbol }) => value.token)", "symbol"],
    ["bigint", "fmap(issue, (value: { count: bigint }) => value.count)", "bigint"],
    ["broad object", "fmap(issue, (value: { raw: object }) => value.raw)", "object"],
    ["async", "fmap(issue, async value => value)", "Promise"],
  ])("reports non-admissible expression callback output %s", (_name, statement, message) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap } from "acpus/expression";

      class View { title = "view"; }
      declare const issue: unknown;
      ${statement};
    `);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "OA002",
      message: expect.stringContaining(message),
      source: expect.objectContaining({ file: "workflow.ts" }),
    }));
  });

  it("does not reject any or unknown expression callback output types during authoring check", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap } from "acpus/expression";

      declare const issue: { loose: any; opaque: unknown };
      fmap(issue, value => value.loose);
      fmap(issue, value => value.opaque);
    `);

    expect(diagnostics.filter(diagnostic => diagnostic.code === "OA002")).toEqual([]);
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

function checkAuthoringWithProgram(source: string): DiagnosticIR[] {
  const fileName = "workflow.ts";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName ? sourceFile : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = name => name === fileName || ts.sys.fileExists(name);
  host.readFile = name => name === fileName ? source : ts.sys.readFile(name);
  const program = ts.createProgram([fileName], options, host);
  return checkWorkflowAuthoring({
    program,
    sourceFile: program.getSourceFile(fileName) ?? sourceFile,
    taskAnalysis: new Map(),
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
    getSymbolAtLocation: () => undefined,
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
