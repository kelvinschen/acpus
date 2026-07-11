import type { DiagnosticIR } from "@acpus/core/ir";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkWorkflowAuthoring } from "../src/check/authoring-rules/index.js";
import type { TaskAuthoringIssue, WorkflowTaskAnalysis } from "../src/task-analysis/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("workflow authoring rules", () => {
  it("reports Expr authoring diagnostics without running the full check pipeline", () => {
    const diagnostics = checkAuthoring(`
      declare const expr: unknown;
      declare const items: unknown[];
      declare const step: any;
      if (expr) {}
      const negated = !expr;
      const logical = expr && true;
      const compared = expr === expr;
      const prompt = \`\${expr}\`;
      const mapped = items.map((item) => item);
      step(String(expr)).assert({ condition: true });
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

  it("leaves expression array properties and methods to TypeScript", () => {
    const diagnostics = checkAuthoring(`
      declare const items: unknown[];
      const first = items[0];
      const mapped = items.map(item => item);
      void [first, mapped];
    `, {
      isExpr: node => ts.isIdentifier(node) && node.text === "items",
    });

    expect(diagnostics).toEqual([]);
  });

  it("reports shadowed runtime globals captured by inline tasks", () => {
    const diagnostics = checkAuthoringWithProgram(`
      export {};
      const Math = { max: (..._values: number[]) => 1 };
      declare const step: any;
      step("inline").task({
        exec: async () => ({ value: Math.max(1, 2) }),
      });
    `);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "TB003",
      message: expect.stringContaining("'Math'"),
      path: "tasks.inline.source",
    }));
  });

  it("reports reason-specific TB004 diagnostics for unjoinable task callsites", () => {
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
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining("literal task step id") }),
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining("object literal") }),
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining('step("id").task') }),
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
      expect.objectContaining({ code: "TB001", path: "tasks.local.reference", hint: expect.any(String) }),
      expect.objectContaining({ code: "TB002", path: "tasks.invalid_export.reference", hint: expect.stringContaining("top-level task") }),
      expect.objectContaining({ code: "TB003", path: "tasks.inline_capture.source", hint: expect.stringContaining("top-level input") }),
      expect.objectContaining({ code: "TB004", path: "tasks.duplicate.reference", hint: expect.stringContaining("unique task step ids") }),
    ]));
  });

  it("uses contiguous AL and TB diagnostic families", () => {
    const exprDiagnostics = checkAuthoring(`
      declare const expr: unknown;
      declare const step: any;
      if (expr) {}
      void (expr && true);
      void (expr === expr);
      void \`value: \${expr}\`;
      step(String(expr)).assert({ condition: true });
    `, {
      isExpr: node => ts.isIdentifier(node) && node.text === "expr",
    });
    const callbackDiagnostics = checkAuthoringWithProgram(`
      import { fmap } from "acpus/expression";
      declare const value: string;
      const suffix = "!";
      fmap(value, value => {
        const value1 = value;
        const value2 = value1;
        const value3 = value2;
        const value4 = value3;
        const value5 = value4;
        const value6 = value5;
        const value7 = value6;
        const value8 = value7;
        return value8 + suffix;
      });
    `);
    const taskDiagnostics = checkAuthoring("", {
      taskAnalysis: new Map([
        ["local", analyzedIssue({ kind: "workflow-local-reusable-task", name: "localTask" })],
        ["invalid", analyzedIssue({ kind: "invalid-reusable-task-reference" })],
        ["capture", analyzedIssue({ kind: "inline-task-capture", names: ["PREFIX"] })],
        ["duplicate", analyzedIssue({ kind: "ambiguous-task-callsite" })],
      ]),
    });

    expect([...new Set(codes([...exprDiagnostics, ...callbackDiagnostics, ...taskDiagnostics]))].sort()).toEqual([
      "AL001",
      "AL002",
      "AL003",
      "AL004",
      "AL005",
      "AL006",
      "TB001",
      "TB002",
      "TB003",
      "TB004",
    ]);
  });

  it("does not retain removed authoring codes in current source, specs, or fixtures", async () => {
    const files = [
      ...await filesUnder(join(repoRoot, "packages", "workflow-compiler", "src")),
      ...await filesUnder(join(repoRoot, "packages", "workflow-compiler", "test", "fixtures")),
      join(repoRoot, "specs", "workflow-compiler-spec.md"),
    ];
    const removedCode = new RegExp(["OA00[1-4]", "AL008", "TB00(?:5|7|8)"].join("|"), "g");
    const hits: string[] = [];
    for (const file of files) {
      const matches = (await readFile(file, "utf8")).match(removedCode);
      if (matches) hits.push(`${file}: ${matches.join(", ")}`);
    }

    expect(hits).toEqual([]);
  });

  it("accepts expression and block fmap and lift callbacks from the expression facade", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap, lift2, lift3, lift as namedLift } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[] };
      declare const count: number;
      declare const limit: number;
      const title = fmap(issue, value => {
        const normalized = value.title.trim();
        return normalized;
      });
      const overLimit = lift2(count, limit, (value, max) => {
        const exceeded = value > max;
        return exceeded;
      });
      const routed = lift3(issue.title, count, limit, (title, value, max) => {
        const total = title.length + value;
        return total > max;
      });
      const named = namedLift({ issue, count, limit }, ({ issue, count, limit }) => ({
        title: issue.title.trim().replace(/\\s+/g, " "),
        urgent: issue.labels.includes("urgent"),
        labels: issue.labels.map(label => label.toLowerCase()),
        count: Math.max(Object.keys(issue).length, count, limit),
        serialized: JSON.stringify(issue),
        now: Date.now(),
        random: Math.random(),
      }));
      const view = expr.fmap(issue, value => {
        const labels = value.labels.map(label => {
          const normalized = label.toLowerCase();
          return normalized;
        });
        return {
          title: value.title.trim(),
          urgent: value.labels.includes("urgent"),
          labels,
          count: Math.max(Object.keys(value).length, 1),
        };
      });
      void [title, overLimit, routed, named, view];
    `);

    expect(codes(diagnostics)).not.toContain("AL006");
  });

  it.each([
    ["function expression", "fmap(issue, function (value) { return value.title; })", "inline arrow function"],
    ["wrong fmap arity", "fmap(issue, () => \"title\")", "simple identifiers or binding patterns"],
    ["wrong lift2 arity", "lift2(issue, issue, value => value.title)", "simple identifiers or binding patterns"],
    ["wrong lift3 arity", "lift3(issue, issue, issue, (a, b) => a.title + b.title)", "simple identifiers or binding patterns"],
    ["wrong lift arity", "lift({ issue }, () => \"title\")", "simple identifiers or binding patterns"],
    ["helper reference", "fmap(issue, helper)", "inline arrow function"],
    ["capture", "fmap(issue, value => value.title + suffix)", "external binding 'suffix'"],
    ["block capture", "fmap(issue, value => { const title = value.title; return title + suffix; })", "external binding 'suffix'"],
    ["this", "fmap(issue, value => this)", "cannot use this"],
    ["shadowed Math", "const Math = { max: (..._values: number[]) => 1 }; fmap(issue, value => Math.max(value.count, 1))", "external binding 'Math'"],
    ["shadowed JSON", "const JSON = { stringify: (_value: unknown) => \"{}\" }; fmap(issue, value => JSON.stringify(value))", "external binding 'JSON'"],
    ["shadowed Date", "const Date = { now: () => 0 }; fmap(issue, value => Date.now() + value.count)", "external binding 'Date'"],
    ["aliased import capture", "combine(issue, issue, (left, right) => left.title + right.title + suffix)", "external binding 'suffix'"],
    ["nested default parameter", "fmap(issue, value => value.labels.map((label = suffix) => label))", "nested callback parameters"],
    ["nested rest parameter", "fmap(issue, value => value.labels.map((...label) => label[0]))", "nested callback parameters"],
    ["nested capture", "fmap(issue, value => value.labels.map(label => label + suffix))", "external binding 'suffix'"],
    ["nested block capture", "fmap(issue, value => value.labels.map(label => { const title = label.trim(); return title + suffix; }))", "external binding 'suffix'"],
  ])("rejects expression callback %s", (_name, statement, message) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap, lift2, lift3, lift, lift2 as combine } from "acpus/expression";

      declare const issue: any;
      declare const helper: (value: unknown) => unknown;
      const suffix = "!";
      ${statement};
    `);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL006");
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

    expect(codes(diagnostics)).not.toContain("AL006");
  });

  it.each([
    ["missing callback", "fmap(issue)"],
    ["non-callable callback", "fmap(issue, 1)"],
    ["excess parameters", "fmap(issue, (value, extra) => value.title)"],
    ["async callback", "fmap(issue, async value => value.title)"],
    ["non-durable output", "fmap(issue, value => new Date(value.title))"],
  ])("leaves %s constraints to TypeScript", (_name, statement) => {
    const diagnostics = checkAuthoringWithProgram(`
      import { fmap } from "acpus/expression";
      declare const issue: { title: string };
      ${statement};
    `);

    expect(diagnostics.filter(diagnostic => diagnostic.code === "AL006")).toEqual([]);
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
    getStringType: () => fakeType({ expr: false, stepDeclaration: false }),
    isTypeAssignableTo: () => true,
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

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".md"))) files.push(path);
  }
  return files;
}
