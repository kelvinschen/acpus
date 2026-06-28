import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeWorkflowTasks } from "../src/compiler/task-provenance.js";

// Static provenance gate. Each test writes a workflow (and task module) to a
// temp dir, runs the parser-only analyzer, and asserts the per-step verdict.
// The verdict drives bundle admission in the compile flow.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-provenance-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function analyze(workflowSource: string, files: Record<string, string> = {}): Promise<ReturnType<typeof analyzeWorkflowTasks>> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  const workflowFile = join(dir, "workflow.ts");
  await writeFile(workflowFile, workflowSource);
  return analyzeWorkflowTasks(workflowFile, workflowSource);
}

const taskModule = `import { task, z } from "@acpus/core";
export default task.define({ inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), exec: async () => ({ ok: true }) });
`;

describe("task provenance analyzer", () => {
  it("accepts a reusable task imported by default from a relative task module", async () => {
    const analysis = await analyze(
      `import t from "./normalize.task.js";
       export default {} as any;
       declare const step: any;
       step("run").task({ task: t, input: {} });`,
      { "normalize.task.ts": taskModule },
    );

    const verdict = analysis.get("run");
    expect(verdict?.error).toBeUndefined();
    expect(verdict?.inline).toBe(false);
    expect(verdict?.sourceFile?.endsWith("normalize.task.ts")).toBe(true);
  });

  it("accepts a reusable task imported by name", async () => {
    const analysis = await analyze(
      `import { normalize } from "./tasks.js";
       declare const step: any;
       step("run").task({ task: normalize, input: {} });`,
      { "tasks.ts": `import { task, z } from "@acpus/core";\nexport const normalize = task.define({ inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), exec: async () => ({ ok: true }) });\n` },
    );

    const verdict = analysis.get("run");
    expect(verdict?.error).toBeUndefined();
    expect(verdict?.inline).toBe(false);
    expect(verdict?.sourceFile?.endsWith("tasks.ts")).toBe(true);
  });

  it("rejects a reusable task defined as a workflow-local value (TB004)", async () => {
    const analysis = await analyze(
      `import { task, z } from "@acpus/core";
       const local = task.define({ inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), exec: async () => ({ ok: true }) });
       declare const step: any;
       step("run").task({ task: local, input: {} });`,
    );

    expect(analysis.get("run")?.error).toMatchObject({ code: "TB004", pathSuffix: ".sourceFile" });
  });

  it("rejects a reusable task whose module export is not task.define(...) (TB005)", async () => {
    const analysis = await analyze(
      `import t from "./not-a-task.js";
       declare const step: any;
       step("run").task({ task: t, input: {} });`,
      { "not-a-task.ts": `export default { fn: async () => ({}) };\n` },
    );

    expect(analysis.get("run")?.error).toMatchObject({ code: "TB005" });
  });

  it("rejects a reusable task imported from a third-party package (TB006)", async () => {
    const analysis = await analyze(
      `import t from "some-pkg";
       declare const step: any;
       step("run").task({ task: t, input: {} });`,
    );

    expect(analysis.get("run")?.error).toMatchObject({ code: "TB006" });
  });

  it("rejects a reusable task re-exported through a barrel (TB006)", async () => {
    const analysis = await analyze(
      `import t from "./index.js";
       declare const step: any;
       step("run").task({ task: t, input: {} });`,
      {
        "index.ts": `export { default } from "./normalize.task.js";\n`,
        "normalize.task.ts": taskModule,
      },
    );

    expect(analysis.get("run")?.error).toMatchObject({ code: "TB006" });
  });

  it("accepts a self-contained inline task", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async ({ input, $, artifact }: any) => {
         const items = [1, 2, 3].map((n: number) => n * 2);
         return { total: items.length };
       } } });`,
    );

    expect(analysis.get("run")?.error).toBeUndefined();
    expect(analysis.get("run")?.inline).toBe(true);
  });

  it("rejects an inline task that references an outer free identifier (TB007)", async () => {
    const analysis = await analyze(
      `import semver from "semver";
       declare const step: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async () => ({ ok: semver.gt("1.0.0", "0.9.0") }) } });`,
    );

    const verdict = analysis.get("run");
    expect(verdict?.error).toMatchObject({ code: "TB007", pathSuffix: ".source" });
    expect(verdict?.error?.message).toContain("semver");
  });

  it("rejects an inline task that captures workflow-scope helpers (TB007)", async () => {
    const analysis = await analyze(
      `declare const step: any;
       declare const where: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async ({ input }: any) => where(input, { ready: true }) } });`,
    );

    expect(analysis.get("run")?.error).toMatchObject({ code: "TB007" });
  });

  it("rejects an inline task that captures an outer value via a destructuring default (TB007)", async () => {
    const analysis = await analyze(
      `import { DEFAULT_RETRIES } from "./config.js";
       declare const step: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async ({ retries = DEFAULT_RETRIES }: any) => ({ retries }) } });`,
    );

    const verdict = analysis.get("run");
    expect(verdict?.error).toMatchObject({ code: "TB007" });
    expect(verdict?.error?.message).toContain("DEFAULT_RETRIES");
  });

  it("does not flag globals, destructured params, or nested locals in inline tasks", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async ({ input, log }: any) => {
         const out: Record<string, number> = {};
         for (const key of Object.keys(input)) {
           const value = JSON.parse(String(input[key]));
           out[key] = Math.max(0, value);
         }
         log.info("done", { count: Object.keys(out).length });
         return out;
       } } });`,
    );

    const verdict = analysis.get("run");
    expect(verdict).toBeDefined();
    expect(verdict?.inline).toBe(true);
    expect(verdict?.error).toBeUndefined();
  });

  it("does not flag a destructuring default that resolves to a local declaration", async () => {
    const analysis = await analyze(
      `declare const step: any;
       step("run").task({ outputSchema: {} as any, run: { input: {}, exec: async ({ limit }: any) => {
         const fallbackLimit = 10;
         const { size = fallbackLimit } = { size: limit };
         return { size };
       } } });`,
    );

    expect(analysis.get("run")?.error).toBeUndefined();
  });
});
