import type { DiagnosticIR } from "@acpus/core/ir";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { officialAuthoringTypeScriptPaths } from "@acpus/loader";
import { describe, expect, it } from "vitest";
import { checkWorkflowAuthoring } from "../src/check/authoring-rules/index.js";
import type { TaskAuthoringIssue, WorkflowTaskAnalysis } from "../src/task-analysis/index.js";
import { withNativeProject } from "../src/typescript/native.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("workflow authoring rules", () => {
  it("reports Expr authoring diagnostics without running the full check pipeline", async () => {
    const diagnostics = await checkAuthoring(`
      import type { Expr as RuntimeExpr } from "acpus/expression";
      import type { StepFactory as DeclareStep } from "acpus/core";
      declare const expr: RuntimeExpr<boolean>;
      declare const items: RuntimeExpr<string[]>;
      declare const step: DeclareStep;
      type ExprLookalike = { __ir: object; __type: boolean };
      type StepDeclaration = { task(spec: object): void };
      declare const fakeExpr: ExprLookalike;
      declare const fakeStep: (id: string) => StepDeclaration;
      declare const saved: StepDeclaration;
      const task = { define: (value: unknown) => value };
      const local = task.define({ exec: async () => ({ ok: true }) });
      if (expr) {}
      const negated = !expr;
      const logical = expr && true;
      const compared = expr === expr;
      const prompt = \`\${expr}\`;
      const mapped = items.map((item) => item);
      step(String(expr)).assert({ condition: true });
      if (fakeExpr) {}
      fakeStep(String(fakeExpr)).task({ task: local });
      saved.task({});
      void [negated, logical, compared, prompt, mapped];
    `);

    expect(codes(diagnostics)).toEqual([
      "AL001",
      "AL001",
      "AL002",
      "AL003",
      "AL004",
      "AL005",
    ]);
    expect(diagnostics.filter(diagnostic => diagnostic.code.startsWith("AL"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ file: expect.stringContaining("workflow.ts") }),
          hint: expect.any(String),
        }),
      ]),
    );
  });

  it("gives syntax-specific Expr replacement hints at the offending expression", async () => {
    const source = `
      import type { Expr } from "acpus/expression";
      declare const flag: Expr<boolean>;
      declare const other: Expr<boolean>;
      declare const note: Expr<string>;
      if (flag) {}
      const conditional = flag ? "yes" : "no";
      const negated = !flag;
      const conjunction = flag && other;
      const disjunction = flag || other;
      const fallback = note || "missing";
      const equal = note === note;
      const looseEqual = note == note;
      const notEqual = note != note;
      const strictNotEqual = note !== note;
      const prompt = \`Status: \${note}\`;
      void [conditional, negated, conjunction, disjunction, fallback, equal, looseEqual, notEqual, strictNotEqual, prompt];
    `;
    const diagnostics = (await checkAuthoring(source)).filter(diagnostic => diagnostic.code.startsWith("AL"));

    expect(diagnostics).toEqual([
      expectedDiagnostic(source, "AL001", "flag) {}", "Use step(\"id\").if({ condition, then, else }) for graph control; use lift(condition, value => ...) only to compute a value."),
      expectedDiagnostic(source, "AL001", "flag ?", "Use lift(condition, value => value ? whenTrue : whenFalse) to compute a conditional value."),
      expectedDiagnostic(source, "AL001", "!flag", "Use not(value) for a boolean predicate, or lift(value, value => !value) to compute a value."),
      expectedDiagnostic(source, "AL002", "flag && other", "Use and(left, right) for boolean Expr operands."),
      expectedDiagnostic(source, "AL002", "flag || other", "Use or(left, right) for boolean Expr operands."),
      expectedDiagnostic(source, "AL002", "note || \"missing\"", "Use unary lift(value, value => value || \"fallback\") for a literal fallback, or pass both operands to binary lift."),
      expectedDiagnostic(source, "AL003", "note === note", "Use eq(left, right) for equality over runtime values."),
      expectedDiagnostic(source, "AL003", "note == note", "Use eq(left, right) for equality over runtime values."),
      expectedDiagnostic(source, "AL003", "note != note", "Use ne(left, right) for inequality over runtime values."),
      expectedDiagnostic(source, "AL003", "note !== note", "Use ne(left, right) for inequality over runtime values."),
      expectedDiagnostic(source, "AL004", "`Status: ${note}`", "Use template or md from acpus/expression."),
    ]);
  });

  it("reports one primary diagnostic for Expr-derived Task ids", async () => {
    const diagnostics = await checkAuthoring(`
      import type { Expr } from "acpus/expression";
      import type { StepFactory } from "acpus/core";
      declare const round: Expr<number>;
      declare const dynamic: string;
      declare const step: StepFactory;
      step(\`agent_\${round}\`).agent({});
      step((\`asserted_\${round}\` as string)).agent({});
      step(\`task_\${round}\`).task({});
      step(dynamic).task({});
    `);

    expect(diagnostics.filter(diagnostic => diagnostic.code === "AL005")).toEqual([
      expect.objectContaining({
        code: "AL005",
        hint: "Use a compile-time string literal such as step(\"review\"); node ids are static graph identity.",
      }),
      expect.objectContaining({
        code: "AL005",
        hint: "Use a compile-time string literal such as step(\"review\"); node ids are static graph identity.",
      }),
      expect.objectContaining({
        code: "AL005",
        hint: "Use a compile-time string literal such as step(\"review\"); node ids are static graph identity.",
      }),
    ]);
    expect(diagnostics.filter(diagnostic => diagnostic.code === "TB004")).toEqual([
      expect.objectContaining({ hint: expect.stringContaining('step("literal").task') }),
    ]);
  });

  it("leaves expression array properties and methods to TypeScript", async () => {
    const diagnostics = await checkAuthoring(`
      import type { Expr } from "acpus/expression";
      declare const items: Expr<string[]>;
      const first = items[0];
      const mapped = items.map(item => item);
      void [first, mapped];
    `);

    expect(diagnostics).toEqual([]);
  });

  it("merges captures once per Task while preserving separate same-name Task diagnostics", async () => {
    const source = `
      import type { StepFactory } from "acpus/core";
      declare const step: StepFactory;
      const prefix = "x";
      const Math = { max: (...values: number[]) => values[0] ?? 0 };
      step("merged").task({
        input: {},
        exec: async () => ({ value: prefix + Math.max(1, 2) }),
      });
      step("one").task({ input: {}, exec: async () => ({ value: prefix }) });
      step("two").task({ input: {}, exec: async () => ({ value: prefix }) });
    `;
    const diagnostics = await checkAuthoringWithProgram(source);
    const captures = diagnostics.filter(diagnostic => diagnostic.code === "TB003");

    expect(captures[0]).toEqual(
      expectedDiagnostic(
        source,
        "TB003",
        "prefix + Math",
        "Pass captured data through Task input. Move helper logic inside exec, dynamically import dependencies there, or use a reusable Task when module imports are required.",
      ),
    );
    expect(captures[0]?.message).toContain("'Math', 'prefix'");
    expect(captures.map(diagnostic => diagnostic.path)).toEqual([
      "tasks.merged.source",
      "tasks.one.source",
      "tasks.two.source",
    ]);
  });

  it("reports reason-specific TB004 diagnostics for unjoinable task callsites", async () => {
    const diagnostics = await checkAuthoring(`
      import type { StepDeclaration, StepFactory } from "acpus/core";
      declare const step: StepFactory;
      declare const dynamic: string;
      declare const spec: object;
      declare const s: StepFactory;
      step(dynamic).task({});
      step("non_object").task(spec);
      declare const saved: StepDeclaration;
      saved.task({});
      s("aliased").task({});
    `);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining('step("literal").task') }),
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining("{ input, exec }") }),
      expect.objectContaining({ code: "TB004", hint: expect.stringContaining('step("literal").task') }),
    ]));
  });

  it("maps task-analysis issues to task-authoring diagnostics", async () => {
    const diagnostics = await checkAuthoring("", {
      taskAnalysis: new Map([
        ["local", analyzedIssue({ kind: "workflow-local-reusable-task", name: "localTask" })],
        ["invalid_export", analyzedIssue({ kind: "invalid-reusable-task-export", importedName: "default", reason: "not-task-define" })],
        ["inline_capture", analyzedIssue({ kind: "inline-task-capture", names: ["PREFIX"] })],
        ["duplicate", analyzedIssue({ kind: "ambiguous-task-callsite", firstSource: { file: "workflow.ts", line: 3, column: 5 } })],
      ]),
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TB001", path: "tasks.local.reference", hint: expect.any(String) }),
      expect.objectContaining({ code: "TB002", path: "tasks.invalid_export.reference", hint: expect.stringContaining("task.define") }),
      expect.objectContaining({ code: "TB004", path: "tasks.duplicate.reference", hint: expect.stringContaining("3:5") }),
    ]));
    expect(diagnostics.some(diagnostic => diagnostic.code === "TB003")).toBe(false);
  });

  it("uses contiguous AL and TB diagnostic families", async () => {
    const exprDiagnostics = await checkAuthoring(`
      import { lift, type Expr } from "acpus/expression";
      import type { StepFactory } from "acpus/core";
      declare const expr: Expr<boolean>;
      declare const step: StepFactory;
      declare const value: unknown;
      declare const taskStep: (id: string) => { task(spec: unknown): unknown };
      let annotated: any;
      const asserted = value as any;
      const array: any[] = [];
      const generic: Array<any> = [];
      type Default<T = any> = T;
      type Keys = keyof any;
      function returnsAny(): any { return annotated; }
      function rest(...values: any[]) { return values; }
      lift(value, (item: any) => item);
      taskStep("inline").task({ exec: async (ctx: any): Promise<any> => ctx });
      // any in a comment is inert.
      const sentence = "any in a string is inert";
      const anything = sentence;
      if (expr) {}
      void (expr && true);
      void (expr === expr);
      void \`value: \${expr}\`;
      step(String(expr)).assert({ condition: true });
      const prefix = "x";
      step("capture").task({ input: {}, exec: async () => ({ value: prefix }) });
      void [asserted, array, generic, returnsAny, rest, anything];
    `);
    const callbackDiagnostics = await checkAuthoringWithProgram(`
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
    const taskDiagnostics = await checkAuthoring("", {
      taskAnalysis: new Map([
        ["local", analyzedIssue({ kind: "workflow-local-reusable-task", name: "localTask" })],
        ["invalid", analyzedIssue({ kind: "invalid-reusable-task-reference" })],
        ["capture", analyzedIssue({ kind: "inline-task-capture", names: ["PREFIX"] })],
        ["duplicate", analyzedIssue({ kind: "ambiguous-task-callsite", firstSource: { file: "workflow.ts", line: 1, column: 1 } })],
      ]),
    });
    const anyDiagnostics = exprDiagnostics.filter(diagnostic => diagnostic.code === "AL007");
    expect(anyDiagnostics).toHaveLength(11);
    expect(anyDiagnostics.map(diagnostic => ({
      line: diagnostic.source?.line,
      column: diagnostic.source?.column,
    }))).toEqual([
      { line: 8, column: 22 },
      { line: 9, column: 33 },
      { line: 10, column: 20 },
      { line: 11, column: 28 },
      { line: 12, column: 24 },
      { line: 13, column: 25 },
      { line: 14, column: 30 },
      { line: 15, column: 32 },
      { line: 16, column: 26 },
      { line: 17, column: 51 },
      { line: 17, column: 65 },
    ]);
    expect(anyDiagnostics).toEqual(anyDiagnostics.map(() => expect.objectContaining({
      code: "AL007",
      severity: "error",
      message: "Explicit 'any' is not allowed in Acpus workflow authoring.",
      hint: "Use a precise type, or use unknown and narrow it before crossing an Acpus boundary.",
      source: expect.objectContaining({
        file: expect.stringContaining("workflow.ts"),
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    })));

    expect([...new Set(codes([...exprDiagnostics, ...callbackDiagnostics, ...taskDiagnostics]))].sort()).toEqual([
      "AL001",
      "AL002",
      "AL003",
      "AL004",
      "AL005",
      "AL006",
      "AL007",
      "TB001",
      "TB002",
      "TB003",
      "TB004",
    ]);
  });

  it("keeps TypeScript 7 native APIs behind the package-internal analysis boundary", async () => {
    const sourceRoot = join(repoRoot, "packages", "workflow-compiler", "src");
    const files = await filesUnder(sourceRoot);
    const bareImports: string[] = [];
    for (const file of files.filter(file => file.endsWith(".ts"))) {
      const source = await readFile(file, "utf8");
      if (/from\s+["']typescript["']/u.test(source)) bareImports.push(file);
    }

    expect(bareImports).toEqual([]);
    await expect(readFile(join(sourceRoot, "index.ts"), "utf8")).resolves.not.toContain("typescript/unstable");
  });

  it("accepts unary, binary, ternary, named, aliased, and namespace lift callbacks from the expression facade", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
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

  it("distinguishes runtime undefined from an external lift helper", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift, md } from "acpus/expression";
      declare const value: string | undefined;
      lift(value, current => current === undefined ? null : current);
      lift(value, current => md\`Value: \${current}\`);
    `);

    expect(diagnostics.filter(diagnostic => diagnostic.code === "AL006")).toEqual([
      expect.objectContaining({
        message: "lift(...) callback cannot reference external binding 'md'.",
        hint: "Pass runtime values through lift's explicit dependencies, using a named object when useful. Do not pass helpers or functions; return plain data and apply md or template outside lift.",
      }),
    ]);
  });

  it("rejects invalid callback forms in one checked program", async () => {
    const callbackCases = [
      ["function expression", "lift(issue, function (value) { return value.title; })", "lift(...) callback must be an inline arrow function."],
      ["missing unary parameter", "lift(issue, () => \"title\")", "lift(...) callback declares 0 parameter(s) for 1 explicit dependency value(s)."],
      ["missing binary parameter", "lift(issue, issue, value => value.title)", "lift(...) callback declares 1 parameter(s) for 2 explicit dependency value(s)."],
      ["missing ternary parameter", "lift(issue, issue, issue, (a, b) => a.title + b.title)", "lift(...) callback declares 2 parameter(s) for 3 explicit dependency value(s)."],
      ["missing named parameter", "lift({ issue }, () => \"title\")", "lift(...) callback declares 0 parameter(s) for 1 explicit dependency value(s)."],
      ["spread arguments", "lift(...[issue, (value: { title: string }) => value.title] as const)", "lift(...) dependencies and callback must be passed as direct arguments."],
      ["callable reference", "lift(issue, helper)", "lift(...) callback must be an inline arrow function."],
      ["capture", "lift(issue, value => value.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["block capture", "lift(issue, value => { const title = value.title; return title + suffix; })", "lift(...) callback cannot reference external binding 'suffix'."],
      ["this", "lift(issue, value => this)", "lift(...) callback cannot use this."],
      ["shadowed Math", "const Math = { max: (..._values: number[]) => 1 }; lift(issue, value => Math.max(value.count, 1))", "lift(...) callback cannot reference external binding 'Math'."],
      ["shadowed JSON", "const JSON = { stringify: (_value: unknown) => \"{}\" }; lift(issue, value => JSON.stringify(value))", "lift(...) callback cannot reference external binding 'JSON'."],
      ["shadowed Date", "const Date = { now: () => 0 }; lift(issue, value => Date.now() + value.count)", "lift(...) callback cannot reference external binding 'Date'."],
      ["shadowed undefined", "const undefined = \"missing\"; lift(issue, value => value.title || undefined)", "lift(...) callback cannot reference external binding 'undefined'."],
      ["aliased import capture", "combine(issue, issue, (left, right) => left.title + right.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["namespace capture", "expr.lift(issue, issue, issue, (a, b, c) => a.title + b.title + c.title + suffix)", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested default parameter", "lift(issue, value => value.labels.map((label = suffix) => label))", "lift(...) nested callback parameter 1 cannot use a default value."],
      ["nested rest parameter", "lift(issue, value => value.labels.map((...label) => label[0]))", "lift(...) nested callback parameter 1 cannot be a rest parameter."],
      ["nested capture", "lift(issue, value => value.labels.map(label => label + suffix))", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested block capture", "lift(issue, value => value.labels.map(label => { const title = label.trim(); return title + suffix; }))", "lift(...) callback cannot reference external binding 'suffix'."],
      ["nested shadow before capture", "lift(issue, value => { value.labels.map(suffix => suffix); return value.title + suffix; })", "lift(...) callback cannot reference external binding 'suffix'."],
    ] as const;
    const source = `
      import { lift, lift as combine } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[]; count: number };
      declare const helper: (value: unknown) => unknown;
      const suffix = "!";
      ${callbackCases.map(([name, statement], index) => `function callbackCase${index}() { // ${name}\n  ${statement};\n}`).join("\n")}
    `;
    const diagnostics = await checkAuthoringWithProgram(source);

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
        source: { file: expect.stringContaining("workflow.ts"), line, column: expect.any(Number) },
      });
    }
  });

  it("rejects non-serializable callback bindings in one checked program", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      declare const issue: { title: string; labels: string[]; count: number };
      lift(issue, (value = issue) => value.title);
      lift(issue, (...values) => values[0].title);
      lift(issue, ({ ["title"]: title }) => title);
    `);

    const callbackDiagnostics = diagnostics.filter(diagnostic => diagnostic.code === "AL006");
    expect(callbackDiagnostics).toHaveLength(3);
    expect(callbackDiagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "lift(...) callback parameter 1 cannot use a default value.",
      "lift(...) callback parameter 1 cannot be a rest parameter.",
      "lift(...) callback parameter 1 cannot use a computed binding name.",
    ]);
  });

  it("inspects lift calls through every supported transparent callee form", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      import * as expr from "acpus/expression";
      declare const issue: { title: string; labels: string[]; count: number };
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

  it("does not report expression callback diagnostics for shadowed facade bindings", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      import * as expr from "acpus/expression";

      declare const issue: { title: string; labels: string[]; count: number };
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

  it("does not inspect lift imported from an internal implementation package", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift as internalLift } from "@acpus/expression";

      declare const issue: { title: string; labels: string[]; count: number };
      const suffix = "!";
      internalLift(issue, value => value.title + suffix);
    `);

    expect(codes(diagnostics)).not.toContain("AL006");
  });

  it("reports callback parameter count while leaving return types to TypeScript", async () => {
    const diagnostics = await checkAuthoringWithProgram(`
      import { lift } from "acpus/expression";
      declare const issue: { title: string };
      lift(issue);
      lift(issue, 1);
      lift(issue, (value, extra) => value.title);
      lift(issue, async value => value.title);
      lift(issue, value => new Date(value.title));
      lift(issue, issue, issue, issue, (a, b, c, d) => a.title + b.title + c.title + d.title);
    `);

    expect(diagnostics.filter(diagnostic => diagnostic.code === "AL006")).toEqual([
      expect.objectContaining({
        message: "lift(...) callback declares 2 parameter(s) for 1 explicit dependency value(s).",
      }),
    ]);
  });
});

async function checkAuthoring(source: string, options: { taskAnalysis?: WorkflowTaskAnalysis } = {}): Promise<DiagnosticIR[]> {
  const scratchDir = mkdtempSync(join(tmpdir(), "acpus-authoring-rules-"));
  const workflow = join(scratchDir, "workflow.ts");
  const configPath = join(scratchDir, "tsconfig.json");
  const officialImports = officialAuthoringTypeScriptPaths(scratchDir);
  writeFileSync(workflow, source);
  writeFileSync(configPath, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      paths: officialImports.paths,
      ...(officialImports.usesSource ? { customConditions: ["development"] } : {}),
      typeRoots: [join(repoRoot, "node_modules", "@types")],
    },
    files: [workflow],
  }, null, 2)}\n`);
  try {
    const result = await withNativeProject(
      { configPath, cwd: repoRoot, sourcePath: workflow, source },
      ({ project, sourceFile }) => checkWorkflowAuthoring({
        project,
        sourceFile,
        taskAnalysis: options.taskAnalysis ?? new Map(),
      }),
    );
    if (result.isErr()) throw new Error(result.error.message);
    return result.value;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function checkAuthoringWithProgram(source: string): Promise<DiagnosticIR[]> {
  return checkAuthoring(source);
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

function expectedDiagnostic(source: string, code: string, needle: string, hint: string): unknown {
  const offset = source.indexOf(needle);
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  return expect.objectContaining({
    code,
    hint,
    source: expect.objectContaining({ line, column }),
  });
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
