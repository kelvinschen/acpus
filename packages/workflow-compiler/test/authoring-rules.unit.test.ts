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
    for (const diagnostic of diagnostics.filter(({ code }) => ["AL001", "AL002", "AL003"].includes(code))) {
      expect(diagnostic.hint).toContain("lift(");
    }
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
      import { lift } from "acpus/expression";
      declare const value: string;
      const suffix = "!";
      lift(value, value => {
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

  it("accepts unary, binary, ternary, named, aliased, and namespace lift callbacks from the expression facade", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift, lift as combine } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[] };
      declare const count: number;
      declare const limit: number;
      const title = lift(issue, value => {
        const normalized = value.title.trim();
        return normalized;
      });
      const overLimit = combine(count, limit, (value, max) => {
        const exceeded = value > max;
        return exceeded;
      });
      const routed = expr.lift(issue.title, count, limit, (title, value, max) => {
        const total = title.length + value;
        return total > max;
      });
      const named = lift({ issue, count, limit }, ({ issue, count, limit }) => ({
        title: issue.title.trim().replace(/\\s+/g, " "),
        urgent: issue.labels.includes("urgent"),
        labels: issue.labels.map(label => label.toLowerCase()),
        count: Math.max(Object.keys(issue).length, count, limit),
        serialized: JSON.stringify(issue),
        now: Date.now(),
        random: Math.random(),
      }));
      const view = expr.lift(issue, value => {
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

  it("rejects invalid callback forms in one checked program", () => {
    const callbackCases = [
      ["function expression", "lift(issue, function (value) { return value.title; })", "lift(...) callback must be an inline arrow function."],
      ["missing unary parameter", "lift(issue, () => \"title\")", "lift(...) callback parameters must match its dependencies and use simple identifiers or binding patterns."],
      ["missing binary parameter", "lift(issue, issue, value => value.title)", "lift(...) callback parameters must match its dependencies and use simple identifiers or binding patterns."],
      ["missing ternary parameter", "lift(issue, issue, issue, (a, b) => a.title + b.title)", "lift(...) callback parameters must match its dependencies and use simple identifiers or binding patterns."],
      ["missing named parameter", "lift({ issue }, () => \"title\")", "lift(...) callback parameters must match its dependencies and use simple identifiers or binding patterns."],
      ["spread arguments", "lift(...[issue, (value: any) => value.title] as const)", "lift(...) dependencies and callback must be passed as direct arguments."],
      ["callable reference", "lift(issue, helper)", "lift(...) callback must be an inline arrow function."],
      ["capture", "lift(issue, value => value.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["block capture", "lift(issue, value => { const title = value.title; return title + suffix; })", "lift(...) callback cannot reference external binding 'suffix'."],
      ["this", "lift(issue, value => this)", "lift(...) callback cannot use this."],
      ["shadowed Math", "const Math = { max: (..._values: number[]) => 1 }; lift(issue, value => Math.max(value.count, 1))", "lift(...) callback cannot reference external binding 'Math'."],
      ["shadowed JSON", "const JSON = { stringify: (_value: unknown) => \"{}\" }; lift(issue, value => JSON.stringify(value))", "lift(...) callback cannot reference external binding 'JSON'."],
      ["shadowed Date", "const Date = { now: () => 0 }; lift(issue, value => Date.now() + value.count)", "lift(...) callback cannot reference external binding 'Date'."],
      ["aliased import capture", "combine(issue, issue, (left, right) => left.title + right.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["namespace capture", "expr.lift(issue, issue, issue, (a, b, c) => a.title + b.title + c.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested default parameter", "lift(issue, value => value.labels.map((label = suffix) => label))", "lift(...) nested callback parameters must be simple identifiers or binding patterns."],
      ["nested rest parameter", "lift(issue, value => value.labels.map((...label) => label[0]))", "lift(...) nested callback parameters must be simple identifiers or binding patterns."],
      ["nested capture", "lift(issue, value => value.labels.map(label => label + suffix))", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested block capture", "lift(issue, value => value.labels.map(label => { const title = label.trim(); return title + suffix; }))", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested shadow before capture", "lift(issue, value => { value.labels.map(suffix => suffix); return value.title + suffix; })", "lift(...) callback cannot reference external binding 'suffix'."],
    ] as const;
    const source = `
      import { lift, lift as combine } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: any;
      declare const helper: (value: unknown) => unknown;
      const suffix = "!";
      ${callbackCases.map(([name, statement], index) => `function callbackCase${index}() { // ${name}\n  ${statement};\n}`).join("\n")}
    `;
    const diagnostics = checkAuthoringWithProgram(source);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL006");
    expect(callbackDiagnostics).toHaveLength(callbackCases.length);
    for (const [name, statement, message] of callbackCases) {
      const line = source.slice(0, source.indexOf(statement)).split("\n").length;
      const caseDiagnostics = callbackDiagnostics.filter(diagnostic => diagnostic.source?.line === line);
      expect(caseDiagnostics, name).toHaveLength(1);
      expect(caseDiagnostics[0], name).toMatchObject({
        code: "AL006",
        message,
        hint: expect.any(String),
        source: { file: "workflow.ts", line, column: expect.any(Number) },
      });
    }
  });

  it("rejects non-serializable callback bindings in one checked program", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      declare const issue: any;
      lift(issue, (value = issue) => value.title);
      lift(issue, (...values) => values[0].title);
      lift(issue, ({ ["title"]: title }) => title);
    `);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL006");
    expect(callbackDiagnostics).toHaveLength(3);
    expect(callbackDiagnostics.every(diagnostic => diagnostic.message.includes("simple identifiers or binding patterns"))).toBe(true);
  });

  it("inspects lift calls through every supported transparent callee form", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      import * as expr from "acpus/expression";
      declare const issue: any;
      const suffix = "!";
      (lift)(issue, value => value.title + suffix);
      (lift as typeof lift)(issue, value => value.title + suffix);
      (<typeof lift>lift)(issue, value => value.title + suffix);
      lift!(issue, value => value.title + suffix);
      (lift satisfies typeof lift)(issue, value => value.title + suffix);
      (expr.lift)(issue, value => value.title + suffix);
      (expr as typeof expr).lift(issue, value => value.title + suffix);
      expr["lift"](issue, value => value.title + suffix);
    `);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL006");
    expect(callbackDiagnostics).toHaveLength(8);
    expect(callbackDiagnostics.every(diagnostic => diagnostic.message.includes("external binding 'suffix'"))).toBe(true);
  });

  it("does not report expression callback diagnostics for shadowed facade bindings", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: any;
      const suffix = "!";
      {
        const lift = (_value: unknown, _fn: unknown) => null;
        lift(issue, value => value.title + suffix);
      }
      function run(expr: { lift: (value: unknown, fn: unknown) => unknown }) {
        expr.lift(issue, value => value.title + suffix);
        expr["lift"](issue, value => value.title + suffix);
      }
      void [lift, expr, run];
    `);

    expect(codes(diagnostics)).not.toContain("AL006");
  });

  it("does not inspect lift imported from an internal implementation package", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift as internalLift } from "@acpus/expression";

      declare const issue: any;
      const suffix = "!";
      internalLift(issue, value => value.title + suffix);
    `);

    expect(codes(diagnostics)).not.toContain("AL006");
  });

  it("leaves type-expressible lift constraints to TypeScript", () => {
    const diagnostics = checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      declare const issue: { title: string };
      lift(issue);
      lift(issue, 1);
      lift(issue, (value, extra) => value.title);
      lift(issue, async value => value.title);
      lift(issue, value => new Date(value.title));
      lift(issue, issue, issue, issue, (a, b, c, d) => a.title + b.title + c.title + d.title);
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
