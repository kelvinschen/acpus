import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { API, Snapshot } from "typescript/unstable/sync";
import { describe, expect, it, vi } from "vitest";
import { checkWorkflow } from "../src/check/runner.js";
import { checkTypeScript } from "../src/check/typescript.js";
import { createScratchDir } from "../src/preflight/temp.js";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

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

  it("does not duplicate bind diagnostics already included in semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-bind-diagnostic", async cwd => {
      const result = await runCheck(cwd, `
        const repeated = 1;
        const repeated = 2;
        export default {};
      `);

      expect(result.diagnostics.filter(({ code }) => code === "TS2451")).toHaveLength(2);
    });
  });

  it("flattens chained TypeScript diagnostics", async () => {
    await withCheckWorkspace("workflow-chained-diagnostic", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        type Expected = { nested: { value: string } };
        const actual = { nested: { value: 1 } };
        const wrong: Expected = actual;

        export default defineWorkflow({ name: "chained_diagnostic" }).build(() => ({ wrong }));
      `);

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "TS2322",
        message: expect.stringMatching(/not assignable[\s\S]+nested\.value/),
      }));
    });
  });

  it("checks the supplied source overlay instead of stale disk text", async () => {
    await withCheckWorkspace("workflow-source-overlay", async cwd => {
      const entry = join(cwd, "workflow.ts");
      const diskSource = "const value: string = 'disk';\nexport default {};\n";
      const overlaySource = "const value: string = 1;\nexport default {};\n";
      await writeFile(entry, diskSource);
      const scratchDir = await createScratchDir();
      try {
        const result = await checkTypeScript(entry, cwd, scratchDir, overlaySource);
        if (result.isErr()) throw new Error(result.error.message);
        expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: "TS2322" }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });

  it("disposes the native snapshot before closing the API", async () => {
    const events: string[] = [];
    const originalDispose = Snapshot.prototype.dispose;
    const originalClose = API.prototype.close;
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      events.push("dispose");
      return originalDispose.call(this);
    });
    const close = vi.spyOn(API.prototype, "close").mockImplementation(function (this: API) {
      const child = (this as unknown as {
        client: { channel: { child: { exitCode: number | null; signalCode: NodeJS.Signals | null } } };
      }).client.channel.child;
      events.push(child.exitCode !== null || child.signalCode !== null ? "close-exited" : "close-live");
      return originalClose.call(this);
    });
    try {
      await withCheckWorkspace("workflow-native-lifecycle", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        expect(result.diagnostics.some(diagnostic => diagnostic.code === "WF002")).toBe(false);
      });
      expect(events.slice(-2)).toEqual(["dispose", "close-exited"]);
    } finally {
      dispose.mockRestore();
      close.mockRestore();
    }
  });

  it("maps cleanup failures to WF002 after closing the native API", async () => {
    const events: string[] = [];
    const originalDispose = Snapshot.prototype.dispose;
    const originalClose = API.prototype.close;
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      events.push("dispose");
      originalDispose.call(this);
      throw new Error("snapshot cleanup failed");
    });
    const close = vi.spyOn(API.prototype, "close").mockImplementation(function (this: API) {
      events.push("close");
      return originalClose.call(this);
    });
    try {
      await withCheckWorkspace("workflow-native-cleanup-failure", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          code: "WF002",
          message: expect.stringContaining("snapshot cleanup failed"),
        }));
      });
      expect(events.slice(-2)).toEqual(["dispose", "close"]);
    } finally {
      dispose.mockRestore();
      close.mockRestore();
    }
  });

  it("preserves the primary native failure when cleanup also fails", async () => {
    const originalDispose = Snapshot.prototype.dispose;
    const getProject = vi.spyOn(Snapshot.prototype, "getProject").mockReturnValue(undefined);
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      originalDispose.call(this);
      throw new Error("secondary cleanup failure");
    });
    try {
      await withCheckWorkspace("workflow-native-primary-failure", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        const failure = result.diagnostics.find(diagnostic => diagnostic.code === "WF002");
        expect(failure?.message).toContain("did not open project");
        expect(failure?.message).not.toContain("secondary cleanup failure");
      });
    } finally {
      getProject.mockRestore();
      dispose.mockRestore();
    }
  });

  it("isolates concurrent native checks across workspaces", async () => {
    const [assignment, implicitAny] = await Promise.all([
      withCheckWorkspace("workflow-concurrent-assignment", cwd => runCheck(cwd, `
        const wrong: string = 1;
        export default { wrong };
      `)),
      withCheckWorkspace("workflow-concurrent-implicit-any", cwd => runCheck(cwd, `
        function identity(value) { return value; }
        export default { value: identity("ok") };
      `)),
    ]);

    expect(assignment.diagnostics).toContainEqual(expect.objectContaining({
      code: "TS2322",
      source: expect.objectContaining({ file: expect.stringContaining("workflow-concurrent-assignment") }),
    }));
    expect(implicitAny.diagnostics).toContainEqual(expect.objectContaining({
      code: "TS7006",
      source: expect.objectContaining({ file: expect.stringContaining("workflow-concurrent-implicit-any") }),
    }));
    expect([...assignment.diagnostics, ...implicitAny.diagnostics].some(({ code }) => code === "WF002")).toBe(false);
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
            agent: agents.reviewer,
            prompt: "review",
          }));
          const client = {
            task: (_spec: object) => ({ ok: true }),
            loop: (_spec: object) => ({ ok: true }),
          };
          client.task({ exec: async () => ({ when: new Date() }) });
          client.loop({ do() { return { ok: true }; } });
          const thirdPartyTask = {
            define: (_spec: object) => ({ ok: true }),
          };
          thirdPartyTask.define({ exec: async () => ({ when: new Date() }) });
          step("inline_hidden").task({
            input: {},
            exec: async (): Promise<Output> => helper(),
          });
          step("same_file_hidden").task({ input: {}, task: inlineHidden });
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

  it("accepts optional concurrency expressions without casts or fixed fallbacks", async () => {
    await withCheckWorkspace("workflow-optional-concurrency", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift } from "acpus/expression";

        export default defineWorkflow({
          name: "optional_concurrency",
          inputSchema: z.object({
            items: z.array(z.string()),
            parallelism: z.number().optional(),
          }),
        }).build(({ input, step }) => {
          step("parallel").parallel({
            maxConcurrency: input.parallelism,
            branches: { only() { return {}; } },
          });
          step("fanout").fanout({
            over: input.items,
            maxConcurrency: lift(input.parallelism, value => value ?? 0),
            do({ item }) { return { item }; },
          });
          return {};
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
          step("date").task({ input: {}, exec: async () => ({ when: new Date() }) });
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
