import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../src/check/runner.js";
import { createScratchDir } from "../src/preflight/temp.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("workflow check pipeline", () => {
  it("converts TypeScript compiler diagnostics to DiagnosticIR", async () => {
    await withCheckWorkspace("workflow-ts-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "@acpus/core";

        const wrong: string = 1;

        export default defineWorkflow({ name: "ts_check" }).build(() => ({ wrong }));
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS2322",
          message: expect.stringContaining("Type 'number' is not assignable to type 'string'"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
    });
  });

  it("reports implicit any from TypeScript semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-implicit-any-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "@acpus/core";

        function id(value) {
          return value;
        }

        export default defineWorkflow({ name: "implicit_any_check" }).build(() => ({ value: id("ok") }));
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS7006",
          message: expect.stringContaining("implicitly has an 'any' type"),
        }),
      ]));
    });
  });

  it("reports missing workflow source as a check diagnostic", async () => {
    await withCheckWorkspace("workflow-missing-check", async cwd => {
      const scratchDir = await createScratchDir();
      try {
        const result = await checkWorkflow(join(cwd, "missing.workflow.ts"), cwd, scratchDir);

        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          code: "WF001",
          path: "workflow",
          source: expect.objectContaining({ file: expect.stringContaining("missing.workflow.ts") }),
        }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });

  it("aggregates TypeScript and Acpus authoring diagnostics", async () => {
    await withCheckWorkspace("workflow-mixed-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "@acpus/core";

        export default defineWorkflow({
          name: "mixed_check",
          inputSchema: z.object({
            ready: z.boolean(),
          }),
        }).build(({ input, step }) => {
          const wrong: string = 1;
          if (input.ready) step("ready").assert({ condition: true });
          return { wrong };
        });
      `);

      expect(codes(result.diagnostics)).toEqual(expect.arrayContaining([
        "TS2322",
        "AL001",
      ]));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "AL001", hint: expect.any(String) }),
      ]));
    });
  });

  it("does not flag compile-time ids or JavaScript arrays of node refs", async () => {
    await withCheckWorkspace("workflow-valid-lint-patterns", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "@acpus/core";

        const ReviewOut = z.object({ ok: z.boolean() });
        const focuses = ["security", "docs"] as const;

        export default defineWorkflow({
          name: "valid_lint_patterns",
          agents: { reviewer: { use: "codex" } },
        }).build(({ agents, step }) => {
          const reviews = focuses.map(id => step(\`review_\${id}\`).agent({
            outputSchema: ReviewOut,
            run: {
              agent: agents.reviewer,
              prompt: "review",
            },
          }));
          return { first: reviews[0].output.ok };
        });
      `);

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("AL") || diagnostic.code === "TB008")).toEqual([]);
    });
  });

  it("ignores unrelated property calls that share step method names", async () => {
    await withCheckWorkspace("workflow-unrelated-methods-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "@acpus/core";

        export default defineWorkflow({ name: "unrelated_methods" }).build(() => {
          const client = {
            task: (_spec: object) => ({ ok: true }),
            loop: (_spec: object) => ({ ok: true }),
          };
          client.task({ run: { exec: async () => ({ when: new Date() }) } });
          client.loop({ do: () => ({ ok: true }) });
          const task = {
            define: (_spec: object) => ({ ok: true }),
          };
          task.define({ exec: async () => ({ when: new Date() }) });
          return {};
        });
      `);

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("OA"))).toEqual([]);
    });
  });

  it("reports non-admissible inferred workflow output types before runtime", async () => {
    await withCheckWorkspace("workflow-output-admissibility-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, z } from "@acpus/core";

        const reusableEscape = task.define({
          inputSchema: z.object({}),
          exec: async (): Promise<any> => ({ leaked: true }),
        });
        const reusableBroadObject = task.define({
          inputSchema: z.object({}),
          exec: async (): Promise<{}> => new Date(),
        });

        export default defineWorkflow({ name: "bad_outputs" }).build(({ step }) => {
          step("inline_date").task({
            run: { input: {}, exec: async () => ({ when: new Date() }) },
          });
          step("inline_function").task({
            run: { input: {}, exec: async () => ({ fn: () => true }) },
          });
          step("inline_broad_object").task({
            run: { input: {}, exec: async (): Promise<{}> => new Date() },
          });
          step("reusable_escape").task({ run: { input: {}, task: reusableEscape } });
          step("reusable_broad_object").task({ run: { input: {}, task: reusableBroadObject } });
          const unknownValue: unknown = "raw";
          return { unknownValue };
        });
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("Date") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("function") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("{}") }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("any"))).toEqual([]);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("unknown"))).toEqual([]);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("inline task output") && diagnostic.message.includes("Date"))).toHaveLength(1);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("inline task output") && diagnostic.message.includes("{}"))).toHaveLength(1);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("task.define exec output") && diagnostic.message.includes("{}"))).toHaveLength(1);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("reusable task output") && diagnostic.message.includes("{}"))).toHaveLength(1);
    });
  });

  it("checks imported reusable task output at the callsite", async () => {
    await withCheckWorkspace("workflow-imported-task-output-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "@acpus/core";
        import { badTask } from "./tasks";

        export default defineWorkflow({ name: "imported_task_output" }).build(({ step }) => {
          step("bad").task({ run: { input: {}, task: badTask } });
          return {};
        });
      `, {
        "tasks.ts": `
          import { task, z } from "@acpus/core";
          export const badTask = task.define({
            inputSchema: z.object({}),
            exec: async () => ({ when: new Date() }),
          });
        `,
      });

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("reusable task output") }),
      ]));
    });
  });

  it("allows typed hidden output producers inside task exec functions", async () => {
    await withCheckWorkspace("workflow-task-hidden-output-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, z } from "@acpus/core";
        import { hiddenTask } from "./tasks";

        type Output = { ok: boolean };
        function helper(): Output {
          return { ok: true };
        }

        const inlineHidden = task.define({
          inputSchema: z.object({}),
          exec: async (): Promise<Output> => helper(),
        });

        export default defineWorkflow({ name: "imported_task_hidden_output" }).build(({ step }) => {
          step("hidden").task({ run: { input: {}, task: hiddenTask } });
          step("inline_hidden").task({
            run: {
              input: {},
              exec: async (): Promise<Output> => helper(),
            },
          });
          step("same_file_hidden").task({ run: { input: {}, task: inlineHidden } });
          return {};
        });
      `, {
        "tasks.ts": `
          import { task, z } from "@acpus/core";
          type Output = { ok: boolean };
          function helper(): Output {
            return { ok: true };
          }
          export const hiddenTask = task.define({
            inputSchema: z.object({}),
            exec: async (): Promise<Output> => helper(),
          });
        `,
      });

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("OA"))).toEqual([]);
    });
  });

  it("allows explicit opaque JsonValue and JsonObject output types", async () => {
    await withCheckWorkspace("workflow-json-output-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, type JsonObject, type JsonValue } from "@acpus/core";

        export default defineWorkflow({ name: "json_outputs" }).build(() => {
          const value = JSON.parse("{}") as JsonValue;
          const object = { ok: true } as JsonObject;
          return { value, object };
        });
      `);

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("OA"))).toEqual([]);
    });
  });

  it("requires statically visible output producer shapes", async () => {
    await withCheckWorkspace("workflow-hidden-output-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "@acpus/core";

        export default defineWorkflow({ name: "hidden_outputs" }).build(({ step }) => {
          const fanoutSpec = { over: ["a"], do: () => ({ ok: true }) };
          step("items").fanout(fanoutSpec);
          const branch = { do: () => ({ ok: true }) };
          step("parallel").parallel({ branches: { branch } });
          const hidden = { ok: true };
          step("spread").if({
            condition: true,
            then: () => ({ ...hidden }),
            else: () => ({ ok: true }),
          });
          const key = "ok";
          step("computed").if({
            condition: true,
            then: () => ({ [key]: true }),
            else: () => ({ ok: true }),
          });
          step("loop_hidden_initial").loop({
            initial: hidden,
            maxIterations: 1,
            do: () => ({ ok: true }),
            stopWhen: () => true,
          });
          return {};
        });
      `);

      const hiddenOutputDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.code === "OA001");
      expect(hiddenOutputDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("fanout spec") }),
        expect.objectContaining({ message: expect.stringContaining("parallel branch") }),
        expect.objectContaining({ message: expect.stringContaining("if then output") }),
        expect.objectContaining({ message: expect.stringContaining("loop initial output") }),
      ]));
      expect(hiddenOutputDiagnostics.filter(diagnostic => diagnostic.message.includes("if then output"))).toHaveLength(2);
      expect(hiddenOutputDiagnostics.filter(diagnostic => diagnostic.message.includes("loop initial output"))).toHaveLength(1);
      expect(hiddenOutputDiagnostics.some(diagnostic => diagnostic.message.includes("task output"))).toBe(false);
    });
  });

  it("reports root output convergence, branch convergence, and loop consistency gaps", async () => {
    await withCheckWorkspace("workflow-output-convergence-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, type JsonValue } from "@acpus/core";

        export default defineWorkflow({ name: "convergence" }).build(({ input, step }) => {
          step("branch_keys").if({
            condition: true,
            then: () => ({ ok: true }),
            else: () => ({ missing: true }),
          });
          step("race_types").parallel({
            strategy: "race",
            branches: {
              left: { do: () => ({ value: "left" }) },
              right: { do: () => ({ value: 1 }) },
            },
          });
          step("switch_keys").switch({
            cases: [{ when: true, then: () => ({ ok: true }) }],
            default: () => ({ missing: true }),
          });
          step("loop").loop({
            initial: { ok: "seed" },
            maxIterations: -1,
            do: () => ({ ok: 1 }),
            stopWhen: () => false,
          });
          const opaque = { ok: true } as JsonValue;
          step("opaque_loop").loop({
            initial: opaque,
            maxIterations: 1,
            do: () => ({ ok: true }),
            stopWhen: () => false,
          });
          if (input) return { ok: true };
          return { missing: true };
        });
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("workflow root outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("if branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("switch branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("parallel race branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("loop initial and body outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("loop initial output") }),
        expect.objectContaining({ code: "OA004" }),
      ]));
    });
  });
});

type WorkflowCheck = Awaited<ReturnType<typeof checkWorkflow>>;

async function runCheck(cwd: string, workflowSource: string, files: Record<string, string> = {}): Promise<WorkflowCheck> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const workflow = join(cwd, "workflow.ts");
  await writeFile(workflow, workflowSource);
  const scratchDir = await createScratchDir();
  try {
    return await checkWorkflow(workflow, cwd, scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function codes(diagnostics: WorkflowCheck["diagnostics"]): string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

async function withCheckWorkspace<T>(name: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await symlink(join(repoRoot, "node_modules"), join(cwd, "node_modules"), "dir");
    await linkWorkspaceCore(cwd);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function linkWorkspaceCore(cwd: string): Promise<void> {
  await mkdir(join(cwd, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(cwd, "packages", "core"), "dir");
}
