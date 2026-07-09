import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeWorkflowTasks } from "../src/task-analysis/index.js";

// Static task analysis produces facts for lint and reusable task references. Rule
// codes and messages belong to the check layer, not to this analyzer.

let dir: string;
type TaskAnalysis = Awaited<ReturnType<typeof analyzeWorkflowTasks>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-provenance-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function analyze(workflowSource: string, files: Record<string, string> = {}): Promise<TaskAnalysis> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  const workflowFile = join(dir, "workflow.ts");
  await writeFile(workflowFile, workflowSource);
  return analyzeWorkflowTasks(workflowFile, workflowSource);
}

const taskModule = `import { task, z } from "acpus/core";
export default task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
`;

describe("task analysis", () => {
  it("accepts a reusable task imported by default from a relative task module", async () => {
    const analysis = await analyze(
      `import t from "./normalize.task.js";
       export default {} as any;
       declare const step: any;
       step("run").task({ run: { task: t, input: {} } });`,
      { "normalize.task.ts": taskModule },
    );

    expectReusableAccepted(analysis, "./normalize.task.js", "default");
  });

  it("accepts a reusable task imported by name", async () => {
    const analysis = await analyze(
      `import { normalize } from "./tasks.js";
       declare const step: any;
       step("run").task({ run: { task: normalize, input: {} } });`,
      { "tasks.ts": `import { task, z } from "acpus/core";\nexport const normalize = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });\n` },
    );

    expectReusableAccepted(analysis, "./tasks.js", "normalize");
  });

  it("accepts an exported top-level reusable task declared in the workflow module", async () => {
    const analysis = await analyze(
      `import { task, z } from "acpus/core";
       export const local = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
       declare const step: any;
       step("run").task({ run: { task: local, input: {} } });`,
    );

    expectWorkflowLocalReusableAccepted(analysis, "local");
  });

  it("accepts a top-level reusable task exported through a named export list", async () => {
    const analysis = await analyze(
      `import { task, z } from "acpus/core";
       const local = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
       export { local };
       declare const step: any;
       step("run").task({ run: { task: local, input: {} } });`,
    );

    expectWorkflowLocalReusableAccepted(analysis, "local");
  });

  it("rejects a non-exported reusable task defined as a workflow-local value (TB004)", async () => {
    const analysis = await analyze(
      `import { task, z } from "acpus/core";
       const local = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
       declare const step: any;
       step("run").task({ run: { task: local, input: {} } });`,
    );

    expectTaskIssue(analysis, { kind: "workflow-local-reusable-task" });
  });

  it("rejects a nested reusable task defined inside workflow scope (TB004)", async () => {
    const analysis = await analyze(
      `import { defineWorkflow, task, z } from "acpus/core";
       export default defineWorkflow({ name: "nested_task" }).build(({ step }) => {
         const nested = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
         step("run").task({ run: { task: nested, input: {} } });
         return { ok: true };
       });`,
    );

    expectTaskIssue(analysis, { kind: "workflow-local-reusable-task" });
  });

  it("rejects a nested task that shadows an exported top-level task", async () => {
    const analysis = await analyze(
      `import { defineWorkflow, task, z } from "acpus/core";
       export const normalize = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
       export default defineWorkflow({ name: "shadow_task" }).build(({ step }) => {
         const normalize = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: false }) });
         step("run").task({ run: { task: normalize, input: {} } });
         return { ok: true };
       });`,
    );

    expectTaskIssue(analysis, { kind: "workflow-local-reusable-task" });
    expect(analysis.get("run")?.metadata).toBeUndefined();
  });

  it("rejects a nested task that shadows an imported task", async () => {
    const analysis = await analyze(
      `import imported from "./normalize.task.js";
       import { defineWorkflow, task, z } from "acpus/core";
       export default defineWorkflow({ name: "shadow_import_task" }).build(({ step }) => {
         const imported = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: false }) });
         step("run").task({ run: { task: imported, input: {} } });
         return { ok: true };
       });`,
      { "normalize.task.ts": taskModule },
    );

    expectTaskIssue(analysis, { kind: "workflow-local-reusable-task" });
    expect(analysis.get("run")?.metadata).toBeUndefined();
  });

  it("rejects a same-file exported value that is not task.define(...) (TB005)", async () => {
    const analysis = await analyze(
      `const local = { fn: async () => ({ ok: true }) };
       export { local };
       declare const step: any;
       step("run").task({ run: { task: local, input: {} } });`,
    );

    expectTaskIssue(analysis, { kind: "invalid-reusable-task-export" });
  });

  it("rejects mutable same-file task exports", async () => {
    const analysis = await analyze(
      `import { task, z } from "acpus/core";
       export let local = task.define({ inputSchema: z.object({}), exec: async () => ({ ok: true }) });
       declare const step: any;
       step("run").task({ run: { task: local, input: {} } });`,
    );

    expectTaskIssue(analysis, { kind: "workflow-local-reusable-task" });
    expect(analysis.get("run")?.metadata).toBeUndefined();
  });

  it("accepts imported reusable task references without parser-time module export validation", async () => {
    const analysis = await analyze(
      `import t from "./not-a-task.js";
       declare const step: any;
       step("run").task({ run: { task: t, input: {} } });`,
      { "not-a-task.ts": `export default { fn: async () => ({}) };\n` },
    );

    expectReusableAccepted(analysis, "./not-a-task.js", "default");
  });

  it("accepts a reusable task imported from a bare package specifier", async () => {
    const analysis = await analyze(
      `import t from "some-pkg";
       declare const step: any;
       step("run").task({ run: { task: t, input: {} } });`,
    );

    expectReusableAccepted(analysis, "some-pkg", "default");
  });

  it("accepts a reusable task re-exported through a barrel", async () => {
    const analysis = await analyze(
      `import t from "./index.js";
       declare const step: any;
       step("run").task({ run: { task: t, input: {} } });`,
      {
        "index.ts": `export { default } from "./normalize.task.js";\n`,
        "normalize.task.ts": taskModule,
      },
    );

    expectReusableAccepted(analysis, "./index.js", "default");
  });

  it("accepts a self-contained inline task", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ run: { input: {}, exec: async ({ input, $, artifact }: any) => {
         const items = [1, 2, 3].map((n: number) => n * 2);
         return { total: items.length };
       } } });`,
    );

    expectInlineAccepted(analysis);
  });

  it("rejects an inline task that references an outer free identifier (TB007)", async () => {
    const analysis = await analyze(
      `import semver from "semver";
       declare const step: any;
       step("run").task({ run: { input: {}, exec: async () => ({ ok: semver.gt("1.0.0", "0.9.0") }) } });`,
    );

    const verdict = analysis.get("run");
    expect(verdict?.issue).toMatchObject({ kind: "inline-task-capture" });
    expect(verdict?.issue && "names" in verdict.issue ? verdict.issue.names : []).toContain("semver");
  });

  it("rejects an inline task that captures workflow-scope helpers (TB007)", async () => {
    const analysis = await analyze(
      `declare const step: any;
       declare const helper: any;
       step("run").task({ run: { input: {}, exec: async ({ input }: any) => helper(input) } });`,
    );

    expectTaskIssue(analysis, { kind: "inline-task-capture" });
  });

  it("rejects an inline task that captures an outer value via a destructuring default (TB007)", async () => {
    const analysis = await analyze(
      `import { DEFAULT_RETRIES } from "./config.js";
       declare const step: any;
       step("run").task({ run: { input: {}, exec: async ({ retries = DEFAULT_RETRIES }: any) => ({ retries }) } });`,
    );

    const verdict = analysis.get("run");
    expect(verdict?.issue).toMatchObject({ kind: "inline-task-capture" });
    expect(verdict?.issue && "names" in verdict.issue ? verdict.issue.names : []).toContain("DEFAULT_RETRIES");
  });

  it("does not flag globals, destructured context fields, or nested locals in inline tasks", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ run: { input: {}, exec: async ({ input, abortSignal }: any) => {
         const out: Record<string, number> = {};
         for (const key of Object.keys(input)) {
           const value = JSON.parse(String(input[key]));
           out[key] = Math.max(0, value);
         }
         if (abortSignal.aborted) return {};
         return out;
       } } });`,
    );

    expectInlineAccepted(analysis);
  });

  it("does not flag a destructuring default that resolves to a local declaration", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ run: { input: {}, exec: async ({ limit }: any) => {
         const fallbackLimit = 10;
         const { size = fallbackLimit } = { size: limit };
         return { size };
       } } });`,
    );

    expect(analysis.get("run")?.issue).toBeUndefined();
  });

  it("does not produce metadata for task specs that cannot be joined from parser-only analysis", async () => {
    const analysis = await analyze(
      `declare const step: any;
       const spec = { run: { input: {}, exec: async () => ({ ok: true }) } };
       step("run").task(spec);`,
    );

    expect(analysis.has("run")).toBe(false);
  });

  it("does not produce metadata for saved step declaration task calls", async () => {
    const analysis = await analyze(
      `declare const step: any;
       const taskStep = step("run");
       taskStep.task({ run: { input: {}, exec: async () => ({ ok: true }) } });`,
    );

    expect(analysis.has("run")).toBe(false);
  });

  it("fails closed when multiple task callsites use the same step id", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ run: { input: {}, exec: async () => ({ ok: true }) } });
       step("run").task({ run: { input: {}, exec: async () => ({ ok: false }) } });`,
    );

    expectTaskIssue(analysis, { kind: "ambiguous-task-callsite" });
    expect(analysis.get("run")?.metadata).toBeUndefined();
  });
});

function expectReusableAccepted(analysis: TaskAnalysis, specifier: string, exportName: string): void {
  const verdict = analysis.get("run");
  expect(verdict?.issue).toBeUndefined();
  expect(verdict?.inline).toBe(false);
  expect(verdict?.metadata?.specifier).toBe(specifier);
  expect(verdict?.metadata?.exportName).toBe(exportName);
}

function expectWorkflowLocalReusableAccepted(analysis: TaskAnalysis, exportName: string): void {
  const verdict = analysis.get("run");
  expect(verdict?.issue).toBeUndefined();
  expect(verdict?.inline).toBe(false);
  expect(verdict?.metadata).toMatchObject({
    specifier: "./workflow.ts",
    exportName,
  });
}

function expectInlineAccepted(analysis: TaskAnalysis): void {
  const verdict = analysis.get("run");
  expect(verdict?.issue).toBeUndefined();
  expect(verdict?.inline).toBe(true);
}

function expectTaskIssue(analysis: TaskAnalysis, expected: { kind: string }): void {
  expect(analysis.get("run")?.issue).toMatchObject(expected);
}
