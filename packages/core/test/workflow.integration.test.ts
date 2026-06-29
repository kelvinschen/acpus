import { describe, expect, it } from "vitest";
import {
  defineWorkflow,
  secret,
  task,
  template,
  z,
} from "../src/index.js";
import { compileWorkflowDefinition } from "../src/workflow.js";
import { eq, fallback, head, matches, or, pick, where } from "../src/expression.js";
import { toSchemaIR } from "../src/schema.js";

const NormalizeInput = z.object({ packageName: z.string() });
const NormalizeOutput = z.object({ normalized: z.string(), slug: z.string() });
const TestOutput = z.object({ passed: z.boolean(), summary: z.string() });
const ReviewOutput = z.object({ ready: z.boolean(), summary: z.string() });
const HumanDecisionOutput = z.object({ approved: z.boolean() });
const StatusOutput = z.object({ status: z.string() });

const normalizePackage = task.define({
  inputSchema: NormalizeInput,
  outputSchema: NormalizeOutput,
  exec: async ({ input }) => ({
    normalized: input.packageName.trim(),
    slug: input.packageName.trim().toLowerCase().replaceAll(" ", "-"),
  }),
});

describe("workflow compilation", () => {
  it("compiles leaf nodes, asserts, secrets, task bundles, and outputs into validated WorkflowIR", () => {
    const definition = defineWorkflow({
      name: "release_review",
      inputSchema: z.object({
        repoPath: z.path(),
        packageName: z.string(),
      }),
      agents: {
        reviewer: {
          use: "codex",
          policy: "read",
          env: { REVIEW_TOKEN: secret("REVIEW_TOKEN") },
        },
      },
    }).build(({ input, step, output }) => {
      const normalized = step("normalize_package").task({
        run: {
          task: normalizePackage,
          input: { packageName: input.packageName },
          params: { strict: true },
        },
      });

      const tests = step("run_tests").task({
        outputSchema: TestOutput,
        run: {
          input: { slug: normalized.output.slug },
          cwd: input.repoPath,
          env: {
            CI: "true",
            PACKAGE_TOKEN: secret("PACKAGE_TOKEN"),
          },
          exec: async ({ input }) => ({
            passed: true,
            summary: `ok:${input.slug}`,
          }),
        },
      });

      step("require_tests").assert({
        condition: where(tests.output, { passed: true }),
        message: template`Tests failed: ${tests.output.summary}`,
      });

      const review = step("review").agent({
        outputSchema: ReviewOutput,
        run: {
          agent: "reviewer",
          prompt: template`Review ${tests.output.summary}`,
          session: { key: template`release:${tests.output.summary}` },
          cwd: input.repoPath,
          env: {
            REVIEW_MODE: "strict",
            REVIEW_TOKEN: secret("REVIEW_TOKEN"),
          },
        },
      });

      const humanGate = step("human_gate").signal({
        outputSchema: HumanDecisionOutput,
        timeout: "5m",
        onTimeout: { action: "fail", message: "Human approval timed out" },
        run: {
          prompt: template`Approve ${review.output.summary} for ${input.packageName}`,
        },
      });

      return output({
        ...pick(review.output, ["ready", "summary"]),
        approved: humanGate.output.approved,
        slug: normalized.output.slug,
      });
    });

    const ir = compileWorkflowDefinition(definition, {
      source: "packages/core/test/workflow.integration.test.ts",
    });

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes.map((node) => node.kind)).toEqual([
      "task",
      "task",
      "assert",
      "agent",
      "signal",
    ]);
    expect(ir.root.nodes.map((node) => node.id)).toEqual([
      "normalize_package",
      "run_tests",
      "require_tests",
      "review",
      "human_gate",
    ]);
    expect(ir.agents).toEqual({
      reviewer: {
        kind: "agent_definition",
        use: "codex",
        policy: "read",
        env: {
          REVIEW_TOKEN: { kind: "secret", name: "REVIEW_TOKEN" },
        },
      },
    });
    expect(ir.root.nodes[0]).toMatchObject({
      kind: "task",
      outputSchema: toSchemaIR(NormalizeOutput),
      run: {
        inline: false,
        params: { strict: true },
        input: {
          packageName: { kind: "ref", path: ["input", "packageName"] },
        },
      },
    });
    expect(ir.root.nodes[1]).toMatchObject({
      kind: "task",
      run: {
        inline: true,
        input: {
          slug: {
            kind: "ref",
            path: ["nodes", "normalize_package", "output", "slug"],
          },
        },
        cwd: { kind: "ref", path: ["input", "repoPath"] },
        env: {
          CI: { kind: "literal", value: "true" },
          PACKAGE_TOKEN: { kind: "secret", name: "PACKAGE_TOKEN" },
        },
      },
    });
    expect(ir.root.nodes[2]).toMatchObject({
      kind: "assert",
      condition: {
        kind: "call",
        fn: "eq",
        args: [
          { kind: "ref", path: ["nodes", "run_tests", "output", "passed"] },
          { kind: "literal", value: true },
        ],
      },
    });
    expect(ir.root.nodes[2]).not.toHaveProperty("that");
    expect(ir.root.nodes[3]).toMatchObject({
      kind: "agent",
      run: {
        agent: "reviewer",
        prompt: {
          parts: [
            { kind: "text", value: "Review " },
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["nodes", "run_tests", "output", "summary"],
              },
            },
          ],
        },
        session: {
          key: {
            parts: [
              { kind: "text", value: "release:" },
              {
                kind: "expr",
                expr: {
                  kind: "ref",
                  path: ["nodes", "run_tests", "output", "summary"],
                },
              },
            ],
          },
        },
        cwd: { kind: "ref", path: ["input", "repoPath"] },
        env: {
          REVIEW_MODE: { kind: "literal", value: "strict" },
          REVIEW_TOKEN: { kind: "secret", name: "REVIEW_TOKEN" },
        },
      },
    });
    expect(ir.root.nodes[3]).not.toHaveProperty("inputs");
    expect((ir.root.nodes[3] as any).run).not.toHaveProperty("use");
    expect(ir.root.nodes[4]).toMatchObject({
      kind: "signal",
      timeout: "5m",
      onTimeout: { action: "fail", message: "Human approval timed out" },
      run: {
        prompt: {
          parts: [
            { kind: "text", value: "Approve " },
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["nodes", "review", "output", "summary"],
              },
            },
            { kind: "text", value: " for " },
            {
              kind: "expr",
              expr: { kind: "ref", path: ["input", "packageName"] },
            },
          ],
        },
      },
    });
    expect(ir.root.nodes[4]).not.toHaveProperty("inputs");
    expect(ir.outputs).toMatchObject({
      ready: { kind: "ref", path: ["nodes", "review", "output", "ready"] },
      summary: { kind: "ref", path: ["nodes", "review", "output", "summary"] },
      approved: {
        kind: "ref",
        path: ["nodes", "human_gate", "output", "approved"],
      },
      slug: {
        kind: "ref",
        path: ["nodes", "normalize_package", "output", "slug"],
      },
    });
    expect(Object.values(ir.assets.taskBundles)).toHaveLength(2);
    expect(
      Object.values(ir.assets.taskBundles).every((bundle) =>
        bundle.digest.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(ir.lock.taskBundleDigests).toEqual(
      Object.fromEntries(
        Object.entries(ir.assets.taskBundles).map(([id, bundle]) => [
          id,
          bundle.digest,
        ]),
      ),
    );
  });

  it("compiles current composite node shapes without invoking a runtime", () => {
    const definition = defineWorkflow({
      name: "composite_flow",
      inputSchema: z.object({
        items: z.array(z.string()),
        shouldRun: z.boolean(),
      }),
    }).build(({ input, step, output }) => {
      const gate = step("gate").if({
        condition: input.shouldRun,
        outputSchema: StatusOutput,
        then: ({ output }) => output({ status: "run" }),
        else: ({ output }) => output({ status: "skip" }),
      });

      const checks = step("checks").parallel({
        branches: {
          fast: {
            outputSchema: StatusOutput,
            do: ({ output }) => output(pick(gate.output, ["status"])),
          },
          slow: {
            outputSchema: z.object({ done: z.boolean() }),
            do: ({ output }) => output({ done: true }),
          },
        },
        maxConcurrency: 2,
      });

      const perItem = step("per_item").fanout({
        over: input.items,
        key: ({ item, itemIndex }) => template`item-${item}-${itemIndex}`,
        itemOutputSchema: z.object({ ok: z.boolean() }),
        do: ({ item, output }) => output({ ok: matches(item, ".+") }),
        maxConcurrency: 4,
      });

      const retry = step("retry_until_done").loop({
        maxIterations: 3,
        outputSchema: z.object({ done: z.boolean(), summary: z.string() }),
        do: ({ iter, previous, output }) =>
          output({
            done: eq(iter, 2),
            summary: fallback(previous.summary, "first"),
          }),
        stopWhen: ({ iter, result }) =>
          or(eq(iter, 3), where(result, { done: true })),
        onExhausted: "returnLast",
      });

      return output({
        status: gate.output.status,
        fastStatus: checks.output.fast.status,
        firstItemOk: fallback(head(perItem.output).ok, false),
        done: retry.output.done,
      });
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes.map((node) => node.kind)).toEqual([
      "if",
      "parallel",
      "fanout",
      "loop",
    ]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "gate",
      kind: "if",
      condition: { kind: "ref", path: ["input", "shouldRun"] },
      outputSchema: { kind: "object" },
    });
    expect(ir.root.nodes[0]).not.toHaveProperty("when");
    expect(ir.root.nodes[0]).not.toHaveProperty("otherwise");
    expect(ir.root.nodes[1]).toMatchObject({
      id: "checks",
      kind: "parallel",
      strategy: "all",
      maxConcurrency: 2,
      branches: {
        fast: {
          outputSchema: { kind: "object" },
          scope: {
            outputs: {
              status: {
                kind: "ref",
                path: ["nodes", "gate", "output", "status"],
              },
            },
          },
        },
      },
    });
    expect(ir.root.nodes[2]).toMatchObject({
      id: "per_item",
      kind: "fanout",
      over: { kind: "ref", path: ["input", "items"] },
      strategy: "all",
      itemOutputSchema: { kind: "object" },
      key: {
        kind: "template",
        parts: [
          { kind: "text", value: "item-" },
          {
            kind: "expr",
            expr: { kind: "ref", path: ["fanout", "per_item", "item"] },
          },
          { kind: "text", value: "-" },
          {
            kind: "expr",
            expr: { kind: "ref", path: ["fanout", "per_item", "itemIndex"] },
          },
        ],
      },
      do: {
        outputs: {
          ok: {
            kind: "call",
            fn: "matches",
            args: [
              { kind: "ref", path: ["fanout", "per_item", "item"] },
              { kind: "literal", value: ".+" },
            ],
          },
        },
      },
    });
    expect(ir.root.nodes[2]).not.toHaveProperty("outputSchema");
    expect(ir.outputs).toMatchObject({
      fastStatus: {
        kind: "ref",
        path: ["nodes", "checks", "output", "fast", "status"],
      },
      firstItemOk: {
        kind: "call",
        fn: "coalesce",
        args: [
          { kind: "ref", path: ["nodes", "per_item", "output", "0", "ok"] },
          { kind: "literal", value: false },
        ],
      },
    });
    expect(ir.root.nodes[3]).toMatchObject({
      id: "retry_until_done",
      kind: "loop",
      maxIterations: 3,
      onExhausted: "returnLast",
      do: {
        outputs: {
          summary: {
            kind: "call",
            fn: "coalesce",
            args: [
              {
                kind: "ref",
                path: ["loop", "retry_until_done", "previous", "summary"],
              },
              { kind: "literal", value: "first" },
            ],
          },
        },
      },
      stopWhen: {
        kind: "call",
        fn: "or",
        args: [
          {
            kind: "call",
            fn: "eq",
            args: [
              { kind: "ref", path: ["loop", "retry_until_done", "iter"] },
              { kind: "literal", value: 3 },
            ],
          },
          {
            kind: "call",
            fn: "eq",
            args: [
              {
                kind: "ref",
                path: ["loop", "retry_until_done", "result", "done"],
              },
              { kind: "literal", value: true },
            ],
          },
        ],
      },
    });
    expect(ir.root.nodes[3]).not.toHaveProperty("until");
  });

  it("diagnoses malformed task specs without crashing compilation", () => {
    const definition = defineWorkflow({ name: "malformed_task" }).build(({ step, output }) => {
      step("bad_task").task({
        run: {
          input: {},
        },
      } as any);
      return output({});
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "T000",
      severity: "error",
    }));
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "T001",
      path: "root.nodes.bad_task.run.bundleId",
    }));
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(0);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "bad_task",
      kind: "task",
      run: { input: {} },
    });
  });

  it("omits optional timeout and exhaustion policy fields for default fail semantics", () => {
    const Output = z.object({ ok: z.boolean() });
    const definition = defineWorkflow({ name: "default_fail_policies" }).build(({ step, output }) => {
      const signal = step("approval").signal({
        outputSchema: Output,
        timeout: "1m",
        run: { prompt: "Approve?" },
      });
      const loop = step("retry").loop({
        maxIterations: 1,
        outputSchema: Output,
        do: ({ output }) => output({ ok: true }),
        stopWhen: ({ result }) => result.ok,
      });
      return output({ ok: signal.output.ok, loop_ok: loop.output.ok });
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "approval",
      kind: "signal",
      timeout: "1m",
    });
    expect(ir.root.nodes[0]).not.toHaveProperty("onTimeout");
    expect(ir.root.nodes[1]).toMatchObject({
      id: "retry",
      kind: "loop",
      maxIterations: 1,
    });
    expect(ir.root.nodes[1]).not.toHaveProperty("onExhausted");
  });

  it("lowers command-backed agent definitions and skips malformed agent definitions", () => {
    const valid = defineWorkflow({
      name: "command_agent_definition",
      agents: {
        worker: {
          command: "acpx worker",
          policy: "full",
          cwd: "/tmp/work",
          env: {
            STATIC: "1",
            TOKEN: secret("WORKER_TOKEN"),
          },
          options: { mode: "batch" },
        },
      },
    }).build(({ step, output }) => {
      step("run_worker").agent({
        run: {
          agent: "worker",
          prompt: "Run worker",
        },
      });
      return output({});
    });

    const validIr = compileWorkflowDefinition(valid);

    expect(validIr.diagnostics).toEqual([]);
    expect(validIr.agents).toEqual({
      worker: {
        kind: "agent_command",
        command: "acpx worker",
        policy: "full",
        cwd: { kind: "literal", value: "/tmp/work" },
        env: {
          STATIC: { kind: "literal", value: "1" },
          TOKEN: { kind: "secret", name: "WORKER_TOKEN" },
        },
        options: { mode: "batch" },
      },
    });
    expect(validIr.root.nodes[0]).toMatchObject({
      kind: "agent",
      run: { agent: "worker" },
    });

    const malformed = defineWorkflow({
      name: "malformed_agent_definition",
      agents: {
        missing_use: { model: "gpt-5.4" },
        mixed: { use: "codex", command: "acpx worker" },
        ir_shaped: { kind: "agent_definition", use: "codex" },
      } as any,
    }).build(({ output }) => output({}));

    const malformedIr = compileWorkflowDefinition(malformed);

    expect(malformedIr.agents).toEqual({});
    expect(malformedIr.diagnostics).toEqual([
      expect.objectContaining({
        code: "A002",
        path: "agents.missing_use",
      }),
      expect.objectContaining({
        code: "A002",
        path: "agents.mixed",
      }),
      expect.objectContaining({
        code: "A002",
        path: "agents.ir_shaped.kind",
      }),
    ]);
  });

  it("compiles race and quorum strategy contracts", () => {
    const Item = z.object({ id: z.string() });
    const Result = z.object({ id: z.string(), ok: z.boolean() });
    const definition = defineWorkflow({
      name: "strategy_flow",
      inputSchema: z.object({
        items: z.array(Item),
      }),
    }).build(({ input, step, output }) => {
      const race = step("first_check").parallel({
        strategy: "race",
        branches: {
          fast: {
            outputSchema: Result,
            do: ({ output }) => output({ id: "fast", ok: true }),
          },
          slow: {
            outputSchema: Result,
            do: ({ output }) => output({ id: "slow", ok: true }),
          },
        },
      });

      const quorum = step("review_quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        itemOutputSchema: Result,
        do: ({ item, output }) => output({ id: item.id, ok: true }),
      });

      return output({
        winner: race.output.winner,
        result: race.output.result,
        accepted: quorum.output.accepted,
      });
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    const race = ir.root.nodes[0];
    expect(race).toMatchObject({
      id: "first_check",
      kind: "parallel",
      strategy: "race",
      branches: {
        fast: { outputSchema: { kind: "object" }, scope: { outputs: { id: { kind: "literal", value: "fast" } } } },
        slow: { outputSchema: { kind: "object" }, scope: { outputs: { id: { kind: "literal", value: "slow" } } } },
      },
    });

    const quorum = ir.root.nodes[1];
    expect(quorum).toMatchObject({
      id: "review_quorum",
      kind: "fanout",
      strategy: "quorum",
      count: 2,
      itemOutputSchema: { kind: "object" },
    });
  });
});
