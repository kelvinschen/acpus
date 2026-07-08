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

  it("accepts pure one-expression transform callbacks from the expression facade", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { transform as fmap } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[] };
      const title = fmap(issue, value => value.title.trim());
      const view = expr.transform(issue, value => ({
        title: value.title.trim(),
        urgent: value.labels.includes("urgent"),
        labels: value.labels.map(label => label.toLowerCase()),
        count: Math.max(Object.keys(value).length, 1),
      }));
      void [title, view];
    `);

    expect(codes(diagnostics)).not.toContain("AL007");
  });

  it.each([
    ["missing callback", "transform(issue)", "requires an inline callback"],
    ["block body", "transform(issue, value => { return value.title; })", "one expression"],
    ["async arrow", "transform(issue, async value => value.title)", "cannot be async"],
    ["function expression", "transform(issue, function (value) { return value.title; })", "inline one-expression arrow"],
    ["generator expression", "transform(issue, function* (value) { yield value.title; })", "inline one-expression arrow"],
    ["wrong arity", "transform(issue, () => \"title\")", "exactly one plain parameter"],
    ["helper reference", "transform(issue, helper)", "inline one-expression arrow"],
    ["helper call", "transform(issue, value => helper(value))", "can only call allowlisted methods"],
    ["capture", "transform(issue, value => value.title + suffix)", "cannot reference 'suffix'"],
    ["this", "transform(issue, value => this)", "cannot use this"],
    ["arguments", "transform(issue, value => arguments)", "cannot reference 'arguments'"],
    ["dynamic import", "transform(issue, value => import(\"dep\"))", "cannot import modules"],
    ["assignment", "transform(issue, value => value.title = \"changed\")", "cannot assign"],
    ["postfix update", "transform(issue, value => value.count++)", "cannot mutate"],
    ["prefix update", "transform(issue, value => ++value.count)", "cannot mutate"],
    ["new expression", "transform(issue, value => new Date())", "cannot use new"],
    ["await expression", "transform(issue, value => await value.title)", "cannot use await"],
    ["comma expression", "transform(issue, value => (value.title, value.id))", "cannot use comma"],
    ["function expression in body", "transform(issue, value => (() => value.title))", "cannot define nested functions"],
    ["class expression", "transform(issue, value => class View {})", "cannot define classes"],
    ["non-allowlisted global", "transform(issue, value => Date.now())", "cannot call method 'now'"],
    ["non-deterministic Math", "transform(issue, value => Math.random())", "Math.random"],
    ["shadowed Math", "const Math = { max: (..._values: number[]) => 1 }; transform(issue, value => Math.max(value.count, 1))", "cannot shadow global Math"],
    ["shadowed Object", "const Object = { keys: (_value: unknown) => [] }; transform(issue, value => Object.keys(value))", "cannot shadow global Object"],
    ["nested block callback", "transform(issue, value => value.labels.map(label => { return label.trim(); }))", "nested callbacks"],
    ["nested async callback", "transform(issue, value => value.labels.map(async label => label.trim()))", "nested callbacks"],
    ["nested default parameter", "transform(issue, value => value.labels.map((label = suffix) => label))", "nested callbacks"],
    ["nested rest parameter", "transform(issue, value => value.labels.map((...label) => label[0]))", "nested callbacks"],
    ["nested capture", "transform(issue, value => value.labels.map(label => label + suffix))", "cannot reference 'suffix'"],
  ])("rejects transform callback %s", (_name, statement, message) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { transform } from "acpus/expression";

      declare const issue: any;
      declare const helper: (value: unknown) => unknown;
      const suffix = "!";
      ${statement};
    `);

    const transformDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL007");
    expect(transformDiagnostics).toHaveLength(1);
    expect(transformDiagnostics[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining(message),
      hint: expect.any(String),
      source: expect.objectContaining({ file: "workflow.ts" }),
    }));
  });

  it("does not report transform diagnostics for shadowed facade bindings", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { transform } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: any;
      {
        const transform = (_value: unknown, _fn: unknown) => null;
        transform(issue, value => { return value.title; });
      }
      function run(expr: { transform: (value: unknown, fn: unknown) => unknown }) {
        expr.transform(issue, value => { return value.title; });
      }
      void [transform, expr, run];
    `);

    expect(codes(diagnostics)).not.toContain("AL007");
  });

  it.each([
    ["Date", "transform(issue, (value: { when: Date }) => value.when)", "Date"],
    ["function", "transform(issue, (value: { fn: () => boolean }) => value.fn)", "function"],
    ["Promise", "transform(issue, (value: { promise: Promise<number> }) => value.promise)", "Promise"],
    ["class instance", "transform(issue, (value: { view: View }) => value.view)", "class instance"],
    ["Map", "transform(issue, (value: { values: Map<string, number> }) => value.values)", "Map"],
    ["Set", "transform(issue, (value: { values: Set<string> }) => value.values)", "Set"],
    ["symbol", "transform(issue, (value: { token: symbol }) => value.token)", "symbol"],
    ["bigint", "transform(issue, (value: { count: bigint }) => value.count)", "bigint"],
    ["broad object", "transform(issue, (value: { raw: object }) => value.raw)", "object"],
  ])("reports non-admissible transform callback output %s", (_name, statement, message) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { transform } from "acpus/expression";

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

  it("does not reject any or unknown transform output types during authoring check", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { transform } from "acpus/expression";

      declare const issue: { loose: any; opaque: unknown };
      transform(issue, value => value.loose);
      transform(issue, value => value.opaque);
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
