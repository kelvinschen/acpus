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
        import { defineWorkflow } from "acpus/core";

        const wrong: string = 1;

        export default defineWorkflow({ name: "ts_check" }).build(() => ({ wrong }));
      `, {
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          include: ["unrelated.ts"],
        }, null, 2)}\n`,
        "unrelated.ts": "const value: string = 1;\n",
      });

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
      expect(result.diagnostics.filter(diagnostic => diagnostic.source?.file?.includes("unrelated.ts"))).toEqual([]);
    });
  });

  it("reports implicit any from TypeScript semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-implicit-any-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

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
        import { defineWorkflow, z } from "acpus/core";

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

  it("allows representative valid authoring and output patterns", async () => {
    await withCheckWorkspace("workflow-valid-patterns", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, type JsonObject, type JsonValue, z } from "acpus/core";

        const ReviewOut = z.object({ ok: z.boolean() });
        const focuses = ["security", "docs"] as const;
        type Output = { ok: boolean };
        function helper(): Output {
          return { ok: true };
        }
        const inlineHidden = task.define({
          inputSchema: z.object({}),
          exec: async (): Promise<Output> => helper(),
        });

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
          const client = {
            task: (_spec: object) => ({ ok: true }),
            loop: (_spec: object) => ({ ok: true }),
          };
          client.task({ run: { exec: async () => ({ when: new Date() }) } });
          client.loop({ do() { return { ok: true }; } });
          const thirdPartyTask = {
            define: (_spec: object) => ({ ok: true }),
          };
          thirdPartyTask.define({ exec: async () => ({ when: new Date() }) });
          step("inline_hidden").task({
            run: {
              input: {},
              exec: async (): Promise<Output> => helper(),
            },
          });
          step("same_file_hidden").task({ run: { input: {}, task: inlineHidden } });
          step("loop").loop({
            state: { ok: true, count: 0, summary: "" },
            do({ round, state }) {
              return {
                state: {
                  ok: state.ok,
                  count: round,
                  summary: state.summary,
                },
                stop: true,
              };
            },
          });
          const value = JSON.parse("{}") as JsonValue;
          const object = { ok: true } as JsonObject;
          return { first: reviews[0].output.ok, value, object };
        });
      `);

      expect(result.diagnostics.filter(diagnostic =>
        diagnostic.code.startsWith("AL")
        || diagnostic.code === "TB008"
        || diagnostic.code.startsWith("OA"),
      )).toEqual([]);
    });
  });

  it("reports invalid expression transform callbacks during check", async () => {
    await withCheckWorkspace("workflow-transform-checks", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { transform } from "acpus/expression";

        const suffix = "!";

        export default defineWorkflow({
          name: "transform_check",
          inputSchema: z.object({
            issue: z.object({
              title: z.string(),
            }),
          }),
        }).build(({ input }) => {
          const title = transform(input.issue, issue => {
            return issue.title + suffix;
          });
          return { title };
        });
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "AL007",
          message: expect.stringContaining("one expression"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
    });
  });

  it("reports representative output source, admissibility, and convergence diagnostics", async () => {
    await withCheckWorkspace("workflow-output-checks", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, type JsonValue, z } from "acpus/core";
        import { badTask } from "./tasks";

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
          step("bad").task({ run: { input: {}, task: badTask } });
          const fanoutSpec = { over: ["a"], do() { return { ok: true }; } };
          step("items").fanout(fanoutSpec);
          function branch() { return { ok: true }; }
          step("parallel").parallel({ branches: { branch } });
          const hidden = { ok: true };
          step("spread").if({
            condition: true,
            then() { return { ...hidden }; },
            else() { return { ok: true }; },
          });
          const key = "ok";
          step("computed").if({
            condition: true,
            then() { return { [key]: true }; },
            else() { return { ok: true }; },
          });
          step("loop_hidden_initial").loop({
            state: hidden,
            do() { return { state: { ok: true }, stop: true }; },
          });
          step("branch_keys").if({
            condition: true,
            then() { return { ok: true }; },
            else() { return { missing: true }; },
          });
          step("race_types").parallel({
            strategy: "race",
            branches: {
              left() {
                return { value: "left" };
              },
              right() { return { value: 1 }; },
            },
          });
          step("switch_keys").switch({
            cases: [{ when: true, then() { return { ok: true }; } }],
            default() { return { missing: true }; },
          });
          step("loop").loop({
            state: { ok: "seed" },
            do() { return { state: { ok: 1 }, stop: false }; },
          });
          const opaque = { ok: true } as JsonValue;
          step("opaque_loop").loop({
            state: opaque,
            do() { return { state: { ok: true }, stop: false }; },
          });
          step("bad_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true }, stop: "yes" as any }; },
          });
          step("extra_transition").loop({
            state: { ok: true },
            do() { return { state: { ok: true }, stop: true, debug: 1 } as any; },
          });
          step("missing_transition_state").loop({
            state: { ok: true },
            do() { return { stop: true } as any; },
          });
          step("missing_transition_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true } } as any; },
          });
          const unknownValue: unknown = "raw";
          if (input) return { ok: true };
          return { missing: true, unknownValue };
        });
      `, {
        "tasks.ts": `
          import { task, z } from "acpus/core";
          export const badTask = task.define({
            inputSchema: z.object({}),
            exec: async () => ({ when: new Date() }),
          });
        `,
      });

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("fanout spec") }),
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("parallel branch") }),
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("if then output") }),
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("loop initial state") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("Date") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("function") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("{}") }),
        expect.objectContaining({ code: "OA002", message: expect.stringContaining("reusable task output") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("workflow root outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("if branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("switch branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("parallel race branch outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("loop initial and transition state outputs") }),
        expect.objectContaining({ code: "OA003", message: expect.stringContaining("loop initial state") }),
        expect.objectContaining({ code: "OA004" }),
        expect.objectContaining({ code: "OA004", message: expect.stringContaining("unexpected key") }),
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("loop transition state") }),
        expect.objectContaining({ code: "OA001", message: expect.stringContaining("loop transition stop") }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("any"))).toEqual([]);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "OA002" && diagnostic.message.includes("unknown"))).toEqual([]);
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
