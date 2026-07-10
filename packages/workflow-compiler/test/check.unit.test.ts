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
        || diagnostic.code === "TB004",
      )).toEqual([]);
    });
  });

  it("reports invalid expression fmap callbacks during check", async () => {
    await withCheckWorkspace("workflow-fmap-checks", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { fmap } from "acpus/expression";

        const suffix = "!";

        export default defineWorkflow({
          name: "fmap_check",
          inputSchema: z.object({
            issue: z.object({
              title: z.string(),
            }),
          }),
        }).build(({ input }) => {
          const title = fmap(input.issue, issue => {
            return issue.title + suffix;
          });
          return { title };
        });
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "AL006",
          message: expect.stringContaining("external binding 'suffix'"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
    });
  });

  it("reports oversized expression callbacks during check", async () => {
    await withCheckWorkspace("workflow-expression-budget", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { fmap } from "acpus/expression";

        export default defineWorkflow({
          name: "expression_budget",
          inputSchema: z.object({ value: z.number() }),
        }).build(({ input }) => {
          const value = fmap(input.value, value => {
            const value1 = value;
            const value2 = value1;
            const value3 = value2;
            const value4 = value3;
            const value5 = value4;
            const value6 = value5;
            const value7 = value6;
            const value8 = value7;
            return value8;
          });
          return { value };
        });
      `);

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "AL007",
        severity: "error",
        message: expect.stringContaining("9 executable statements"),
        hint: expect.stringContaining("Task"),
      }));
    });
  });

  it("accepts loop transition shorthand properties and still checks their types and keys", async () => {
    await withCheckWorkspace("workflow-loop-shorthand", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift2 } from "acpus/expression";

        export default defineWorkflow({
          name: "loop_shorthand",
          inputSchema: z.object({ shouldContinue: z.boolean() }),
        }).build(({ input, step }) => {
          const shorthand = step("shorthand").loop({
            state: { round: 0, shouldContinue: true },
            do({ round }) {
              const state = { round, shouldContinue: input.shouldContinue };
              const stop = lift2(input.shouldContinue, round, (shouldContinue, currentRound) => !shouldContinue || currentRound >= 2);
              return { state, stop };
            },
          });
          const explicit = step("explicit").loop({
            state: { round: 0, shouldContinue: true },
            do({ round }) {
              const state = { round, shouldContinue: input.shouldContinue };
              const stop = lift2(input.shouldContinue, round, (shouldContinue, currentRound) => !shouldContinue || currentRound >= 2);
              return { state: state, stop: stop };
            },
          });
          return { shorthand: shorthand.output, explicit: explicit.output };
        });
      `);

      expect(result.diagnostics).toEqual([]);
    });
  });

  it("accepts aliases, spreads, computed keys, callback variables, and heterogeneous branches", async () => {
    await withCheckWorkspace("workflow-output-source-shapes", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_source_shapes" }).build(({ step }) => {
          const hidden = { ok: true };
          const fanoutSpec = { over: ["a"], do() { return { ok: true }; } };
          step("items").fanout(fanoutSpec);
          function branch() { return { ok: true }; }
          step("parallel").parallel({ branches: { branch } });
          step("spread").if({
            condition: true,
            then() { return { ...hidden }; },
            else() { return { missing: true }; },
          });
          const key = "computed";
          step("computed").if({
            condition: true,
            then() { return { [key]: true }; },
            else() { return { fallback: true }; },
          });
          step("loop").loop({
            state: hidden,
            do() {
              const state = { ok: true };
              const stop = true;
              return { state, stop };
            },
          });
          step("switch").switch({
            cases: [{ when: true, then() { return { selected: true }; } }],
            default() { return { fallback: true }; },
          });
          return { ok: true };
        });
      `);

      expect(result.diagnostics).toEqual([]);
    });
  });

  it("reports durable output and loop contract violations as TypeScript diagnostics only", async () => {
    await withCheckWorkspace("workflow-output-types", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_types" }).build(({ step }) => {
          step("date").task({ run: { input: {}, exec: async () => ({ when: new Date() }) } });
          step("if_date").if({
            condition: true,
            then() { return { when: new Date() }; },
            else() { return { ok: true }; },
          });
          step("switch_date").switch({
            cases: [{ when: true, then() { return { when: new Date() }; } }],
            default() { return { ok: true }; },
          });
          step("parallel_date").parallel({
            branches: {
              invalid() { return { when: new Date() }; },
              valid() { return { ok: true }; },
            },
          });
          step("fanout_date").fanout({
            over: ["item"],
            do() { return { when: new Date() }; },
          });
          step("missing_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true } }; },
          });
          step("bad_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true }, stop: "yes" }; },
          });
          return { ok: true };
        });
      `);

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("TS")).length).toBeGreaterThanOrEqual(7);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("OA"))).toEqual([]);
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
