import { describe, expect, it } from "vitest";
import {
  defineWorkflow,
  task,
  type StepDeclaration,
  type StepFactory,
  z,
} from "../src/index.js";
import { compileWorkflowDefinition, tryCompileWorkflowDefinition } from "../src/workflow.js";
import { lift, template } from "@acpus/expression";

const NormalizeInput = z.object({ packageName: z.string() });
const ReviewOutput = z.object({ ready: z.boolean(), summary: z.string() });
const HumanDecisionOutput = z.object({ approved: z.boolean() });

const normalizePackage = task.define({
  inputSchema: NormalizeInput,
  exec: async ({ input }) => ({
    normalized: input.packageName.trim(),
    slug: input.packageName.trim().toLowerCase().replaceAll(" ", "-"),
  }),
});

describe("workflow compilation", () => {
  it("emits one validator-owned ID001 and lets validate:false opt out", () => {
    const definition = defineWorkflow({ name: "invalid_id" }).build(({ step }) => {
      step("bad id").assert({ condition: true });
      return { ok: true };
    });

    expect(compileWorkflowDefinition(definition).diagnostics).toEqual([
      expect.objectContaining({
        code: "ID001",
        path: "root.nodes.bad id",
        message: expect.stringContaining("/^[A-Za-z_][A-Za-z0-9_-]*$/"),
        hint: expect.stringContaining("compile-time string literal"),
      }),
    ]);
    expect(compileWorkflowDefinition(definition, { validate: false }).diagnostics).toEqual([]);
  });

  it("compiles leaf nodes, asserts, task descriptors, and outputs into WorkflowIR", () => {
    const definition = defineWorkflow({
      name: "release_review",
      description: "Review a package release for readiness.",
      inputSchema: z.object({
        repoPath: z.string(),
        packageName: z.string(),
      }),
      agents: {
        reviewer: {
          use: "codex",
          permissionMode: "approve-reads",
          config: { model: "gpt-5.4", mode: "agent" },
          trace: true,
          env: { REVIEW_PROFILE: "strict" },
        },
      },
    }).build(({ input, agents, meta, step }) => {
      const normalized = step("normalize_package").task({
        task: normalizePackage,
        input: { packageName: input.packageName },
      });

      const tests = step("run_tests").task({
        input: { slug: normalized.output.slug },
        cwd: input.repoPath,
        env: {
          CI: "true",
        },
        exec: async ({ input }) => ({
          passed: true,
          summary: `ok:${input.slug}`,
        }),
      });

      step("require_tests").assert({
        condition: lift(tests.output, output => output.passed === true),
        message: template`Tests failed: ${tests.output.summary}`,
      });

      const review = step("review").agent({
        outputSchema: ReviewOutput,
        agent: agents.reviewer,
        prompt: template`Review ${tests.output.summary}`,
        sessionKey: template`release:${tests.output.summary}`,
        cwd: input.repoPath,
        env: {
          REVIEW_MODE: "strict",
          PACKAGE_NAME: input.packageName,
        },
      });

      const humanGate = step("human_gate").signal({
        outputSchema: HumanDecisionOutput,
        timeout: "5m",
        onTimeout: { message: "Human approval timed out" },
        prompt: template`Approve ${review.output.summary} for ${input.packageName}`,
      });

      return {
        ready: review.output.ready,
        summary: review.output.summary,
        approved: humanGate.output.approved,
        slug: normalized.output.slug,
        runId: meta.runId,
      };
    });

    const ir = compileWorkflowDefinition(definition, {
      validate: false,
      reusableTasks: {
        referrerPath: "workflows/release.workflow.ts",
        targets: new Map([[
          "normalize_package",
          { specifier: "./normalize-package.task.js", exportName: "normalizePackage" },
        ]]),
      },
    });

    expect(ir.diagnostics).toEqual([]);
    expect(ir.irVersion).toBe(6);
    expect(ir).not.toHaveProperty("lock");
    expect(ir.description).toBe("Review a package release for readiness.");
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
        permissionMode: "approve-reads",
        config: { model: "gpt-5.4", mode: "agent" },
        trace: true,
        env: {
          REVIEW_PROFILE: "strict",
        },
      },
    });
    expect(ir.root.nodes[0]).toMatchObject({
      kind: "task",
      run: {
        target: {
          kind: "module",
          specifier: "./normalize-package.task.js",
          exportName: "normalizePackage",
          referrer: { path: "workflows/release.workflow.ts" },
        },
        input: {
          packageName: { kind: "ref", path: ["input", "packageName"] },
        },
      },
    });
    expect(ir.root.nodes[1]).toMatchObject({
      kind: "task",
      run: {
        target: { kind: "inline", source: expect.any(String) },
        input: {
          slug: {
            kind: "ref",
            path: ["nodes", "normalize_package", "output", "slug"],
          },
        },
        cwd: { kind: "ref", path: ["input", "repoPath"] },
        env: {
          CI: { kind: "literal", value: "true" },
        },
      },
    });
    expect(ir.root.nodes[2]).toMatchObject({
      kind: "assert",
      condition: {
        kind: "call",
        fn: "lift",
        args: [
          { kind: "ref", path: ["nodes", "run_tests", "output"] },
          { kind: "literal", value: expect.any(String) },
        ],
      },
    });
    expect(ir.root.nodes[2]).not.toHaveProperty("that");
    expect(ir.root.nodes[3]).toMatchObject({
      kind: "agent",
      run: {
        agent: "reviewer",
        prompt: {
          kind: "template",
          parts: [
            { kind: "text", value: "Review " },
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["nodes", "run_tests", "output", "summary"],
              },
            },
            { kind: "text", value: "" },
          ],
        },
        sessionKey: {
          kind: "template",
          parts: [
            { kind: "text", value: "release:" },
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["nodes", "run_tests", "output", "summary"],
              },
            },
            { kind: "text", value: "" },
          ],
        },
        cwd: { kind: "ref", path: ["input", "repoPath"] },
        env: {
          REVIEW_MODE: { kind: "literal", value: "strict" },
          PACKAGE_NAME: { kind: "ref", path: ["input", "packageName"] },
        },
      },
    });
    expect(ir.root.nodes[3]).not.toHaveProperty("inputs");
    expect((ir.root.nodes[3] as any).run).not.toHaveProperty("use");
    expect(ir.root.nodes[4]).toMatchObject({
      kind: "signal",
      timeout: { kind: "literal", value: "5m" },
      onTimeout: { message: { kind: "literal", value: "Human approval timed out" } },
      run: {
        prompt: {
          kind: "template",
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
            { kind: "text", value: "" },
          ],
        },
      },
    });
    expect(ir.root.nodes[4]).not.toHaveProperty("inputs");
    expect(ir.root.output).toMatchObject({ kind: "object", fields: {
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
      runId: { kind: "ref", path: ["meta", "runId"] },
    } });
    expect(ir.root.nodes[0]).toMatchObject({
      kind: "task",
      run: {
        target: { kind: "module" },
      },
    });
    expect(ir.root.nodes.every(node => !("source" in node))).toBe(true);
    expect((ir.root.nodes[0] as any).run).not.toHaveProperty("kind");
    expect((ir.root.nodes[0] as any).run.target).not.toHaveProperty("runtime");
    expect((ir.root.nodes[0] as any).run.target.referrer).not.toHaveProperty("kind");
    expect(ir.root.nodes[0]).not.toHaveProperty("outputSchema");
    expect(ir.root.nodes[1]).toMatchObject({
      kind: "task",
      run: {
        target: { kind: "inline", source: expect.any(String) },
      },
    });
    expect((ir.root.nodes[1] as any).run).not.toHaveProperty("kind");
    expect((ir.root.nodes[1] as any).run.target).not.toHaveProperty("runtime");
    expect((ir.root.nodes[3] as any).run).not.toHaveProperty("kind");
    expect((ir.root.nodes[4] as any).run).not.toHaveProperty("kind");
    expect(ir.root.nodes[1]).not.toHaveProperty("outputSchema");
  });

  it("lowers the same definition to identical WorkflowIR", () => {
    const definition = defineWorkflow({ name: "deterministic_lowering" }).build(({ step }) => {
      const result = step("run").task({
        input: { value: "stable" },
        exec: async ({ input }) => ({ value: input.value }),
      });
      return { value: result.output.value };
    });

    expect(compileWorkflowDefinition(definition)).toEqual(compileWorkflowDefinition(definition));
  });

  it("rejects literal undefined graph binding fields during lowering", () => {
    expect(() => compileWorkflowDefinition(defineWorkflow({
      name: "reject_undefined_outputs",
      // Exercise the runtime lowering backstop independently of authoring types.
    }).build((() => ({ omitted: undefined })) as any))).toThrow("Unsupported expression value at key 'omitted': undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({
      name: "reject_nested_undefined_outputs",
    }).build((() => ({ payload: { kept: "nested", omitted: undefined } })) as any))).toThrow("Unsupported expression value at key 'omitted': undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({ name: "reject_undefined_task_input" }).build(({ step }) => {
      step("task").task({
        input: { omitted: undefined as any }, exec: async () => ({}),
      });
      return {};
    }))).toThrow("Unsupported expression value at key 'omitted': undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({ name: "reject_undefined_composite_output" }).build(({ step }) => {
      step("parallel").parallel({
        branches: { only: (() => ({ omitted: undefined })) as any },
      });
      return {};
    }))).toThrow("Unsupported expression value at key 'omitted': undefined.");
  });

  it("compiles current composite node shapes without invoking a runtime", () => {
    const definition = defineWorkflow({
      name: "composite_flow",
      inputSchema: z.object({
        items: z.array(z.string()),
        shouldRun: z.boolean(),
      }),
    }).build(({ input, step }) => {
      const gate = step("gate").if({
        condition: input.shouldRun,
        then() { return { status: "run" }; },
        else() { return { status: "skip" }; },
      });

      const checks = step("checks").parallel({
        branches: {
          fast() { return { status: gate.output.status }; },
          slow() { return { done: true }; },
        },
        maxConcurrency: 2,
      });

      const perItem = step("per_item").fanout({
        over: input.items,
        do({ item }) { return { ok: lift(item, value => /.+/.test(value)) }; },
        maxConcurrency: 4,
      });

      const retry = step("retry_until_done").loop({
        state: { done: false as boolean, summary: "first" },
        do({ round, state }) { return {
            state: {
              done: lift(round, value => value === 3),
              summary: state.summary,
            },
            stop: lift(round, state.done, (value, done) => value === 3 || done === true),
          }; },
      });

      return {
        status: gate.output.status,
        fastStatus: checks.output.fast.status,
        firstItemOk: lift(perItem.output, items => items[0]?.ok ?? false),
        done: retry.output.done,
      };
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
    });
    expect(ir.root.nodes[0]).not.toHaveProperty("outputSchema");
    expect(ir.root.nodes[0]).not.toHaveProperty("when");
    expect(ir.root.nodes[0]).not.toHaveProperty("otherwise");
    expect(ir.root.nodes[1]).toMatchObject({
      id: "checks",
      kind: "parallel",
      strategy: "all",
      maxConcurrency: { kind: "literal", value: 2 },
      branches: {
        fast: {
          output: { kind: "object", fields: {
            status: {
              kind: "ref",
              path: ["nodes", "gate", "output", "status"],
            },
          } },
        },
      },
    });
    expect((ir.root.nodes[1] as any).branches.fast).not.toHaveProperty("outputSchema");
    expect(ir.root.nodes[2]).toMatchObject({
      id: "per_item",
      kind: "fanout",
      over: { kind: "ref", path: ["input", "items"] },
      strategy: "all",
      do: {
        output: { kind: "object", fields: {
          ok: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["fanout", "per_item", "item"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        } },
      },
    });
    expect(ir.root.nodes[2]).not.toHaveProperty("itemOutputSchema");
    expect(ir.root.nodes[2]).not.toHaveProperty("outputSchema");
    expect(ir.root.output).toMatchObject({ kind: "object", fields: {
      fastStatus: {
        kind: "ref",
        path: ["nodes", "checks", "output", "fast", "status"],
      },
      firstItemOk: {
        kind: "call",
        fn: "lift",
        args: [
          { kind: "ref", path: ["nodes", "per_item", "output"] },
          { kind: "literal", value: expect.any(String) },
        ],
      },
    } });
    expect(ir.root.nodes[3]).toMatchObject({
      id: "retry_until_done",
      kind: "loop",
      state: {
        kind: "object",
        fields: {
          done: { kind: "literal", value: false },
          summary: { kind: "literal", value: "first" },
        },
      },
      do: {
        output: { kind: "object", fields: {
          state: {
            kind: "object",
            fields: {
              done: {
                kind: "call",
                fn: "lift",
                args: [
                  { kind: "ref", path: ["loop", "retry_until_done", "round"] },
                  { kind: "literal", value: expect.any(String) },
                ],
              },
              summary: {
                kind: "ref",
                path: ["loop", "retry_until_done", "state", "summary"],
              },
            },
          },
          stop: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["loop", "retry_until_done", "round"] },
              { kind: "ref", path: ["loop", "retry_until_done", "state", "done"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        } },
      },
    });
    expect(ir.root.nodes[3]).not.toHaveProperty("outputSchema");
    expect(ir.root.nodes[3]).not.toHaveProperty("until");
  });

  it("preserves zero concurrency as an authored runtime sentinel", () => {
    const ir = compileWorkflowDefinition(defineWorkflow({ name: "zero_concurrency" }).build(({ step }) => {
      step("parallel").parallel({
        maxConcurrency: 0,
        branches: { only() { return {}; } },
      });
      return {};
    }));

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      kind: "parallel",
      maxConcurrency: { kind: "literal", value: 0 },
    });
  });

  it("preserves own __proto__ fields through workflow object-map lowering", () => {
    const taskInput = Object.fromEntries([["__proto__", "safe"]]);
    const agents = Object.fromEntries([["__proto__", { use: "codex" }]]);
    const definition = defineWorkflow({ name: "proto_fields", agents }).build(({ agents, step }) => {
      step("inspect").task({
        input: taskInput,
        exec: async ({ input }) => input,
      });
      step("review").agent({
        agent: agents.__proto__!,
        prompt: "Review",
      });
      return {};
    });

    const ir = compileWorkflowDefinition(definition);
    const task = ir.root.nodes[0];

    expect(task?.kind).toBe("task");
    if (!task || task.kind !== "task") throw new Error("Expected Task node.");
    expect(Object.getPrototypeOf(task.run.input)).toBe(Object.prototype);
    expect(Object.hasOwn(task.run.input, "__proto__")).toBe(true);
    expect(task.run.input.__proto__).toEqual({ kind: "literal", value: "safe" });
    expect(Object.getPrototypeOf(ir.agents)).toBe(Object.prototype);
    expect(Object.hasOwn(ir.agents, "__proto__")).toBe(true);
    expect(ir.agents.__proto__).toEqual({ kind: "agent_definition", use: "codex" });
  });

  it("declares closed-over step calls in the active fanout scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_fanout_step",
      inputSchema: z.object({
        items: z.array(z.string()),
      }),
    }).build(({ input, step }) => {
      const fanout = step("per_item").fanout({
        over: input.items,
        do({ item }) {
          const echoed = step("fanout_echo").task({
            input: { value: item },
            exec: async ({ input }) => ({ value: input.value }),
          });
          return { value: echoed.output.value };
        },
      });

      return { first: lift(fanout.output, items => items[0]?.value ?? null) };
    });

    const ir = compileWorkflowDefinition(definition);
    const fanout = ir.root.nodes.find((node) => node.id === "per_item");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fanout_echo" }),
    ]));
    expect(fanout).toMatchObject({
      kind: "fanout",
      do: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "fanout_echo", kind: "task" })] },
    });
  });

  it("declares closed-over step calls in the active parallel scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_parallel_step",
    }).build(({ step }) => {
      const parallel = step("lanes").parallel({
        branches: {
          left() {
            const echoed = step("parallel_left_echo").task({
              input: { value: "left" },
              exec: async ({ input }) => ({ value: input.value }),
            });
            return { value: echoed.output.value };
          },
          right() { return { value: "right" }; },
        },
      });

      return { left: parallel.output.left.value };
    });

    const ir = compileWorkflowDefinition(definition);
    const parallel = ir.root.nodes.find((node) => node.id === "lanes");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "parallel_left_echo" }),
    ]));
    expect(parallel).toMatchObject({
      kind: "parallel",
      branches: {
        left: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "parallel_left_echo", kind: "task" })] },
      },
    });
  });

  it("declares closed-over step calls in the active if scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_if_step",
      inputSchema: z.object({
        enabled: z.boolean(),
      }),
    }).build(({ input, step }) => {
      const gate = step("gate").if({
        condition: input.enabled,
        then() {
          const echoed = step("if_then_echo").task({
            input: { value: "then" },
            exec: async ({ input }) => ({ value: input.value }),
          });
          return { value: echoed.output.value };
        },
        else() { return { value: "else" }; },
      });

      return { gate: gate.output.value };
    });

    const ir = compileWorkflowDefinition(definition);
    const gate = ir.root.nodes.find((node) => node.id === "gate");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "if_then_echo" }),
    ]));
    expect(gate).toMatchObject({
      kind: "if",
      then: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "if_then_echo", kind: "task" })] },
    });
  });

  it("declares cached step declarations in the active composite scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_cached_step_declaration",
    }).build(({ step }) => {
      const cached = step("cached_echo");
      const gate = step("gate").if({
        condition: true,
        then() {
          const echoed = cached.task({
            input: { value: "then" },
            exec: async ({ input }) => ({ value: input.value }),
          });
          return { value: echoed.output.value };
        },
        else() { return { value: "else" }; },
      });

      return { gate: gate.output.value };
    });

    const ir = compileWorkflowDefinition(definition);
    const gate = ir.root.nodes.find((node) => node.id === "gate");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cached_echo" }),
    ]));
    expect(gate).toMatchObject({
      kind: "if",
      then: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "cached_echo", kind: "task" })] },
    });
  });

  it("declares closed-over step calls in the active switch scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_switch_step",
      inputSchema: z.object({
        enabled: z.boolean(),
      }),
    }).build(({ input, step }) => {
      const routed = step("routed").switch({
        cases: [
          {
            when: input.enabled,
            then() {
              const echoed = step("switch_case_echo").task({
                input: { value: "case" },
                exec: async ({ input }) => ({ value: input.value }),
              });
              return { value: echoed.output.value };
            },
          },
        ],
        default() { return { value: "default" }; },
      });

      return { route: routed.output.value };
    });

    const ir = compileWorkflowDefinition(definition);
    const routed = ir.root.nodes.find((node) => node.id === "routed");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "switch_case_echo" }),
    ]));
    expect(routed).toMatchObject({
      kind: "switch",
      cases: [
        { then: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "switch_case_echo", kind: "task" })] } },
      ],
    });
  });

  it("declares closed-over step calls in the active loop scope", () => {
    const definition = defineWorkflow({
      name: "active_scope_loop_step",
    }).build(({ step }) => {
      const loop = step("retry").loop({
        state: { value: "initial" as string },
        do({ state }) {
          const echoed = step("loop_echo").task({
            input: { value: state.value },
            exec: async ({ input }) => ({ value: input.value }),
          });
          return { state: { value: echoed.output.value }, stop: true };
        },
      });

      return { loop: loop.output.value };
    });

    const ir = compileWorkflowDefinition(definition);
    const loop = ir.root.nodes.find((node) => node.id === "retry");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "loop_echo" }),
    ]));
    expect(loop).toMatchObject({
      kind: "loop",
      do: { output: { kind: "object", fields: {} }, nodes: [expect.objectContaining({ id: "loop_echo", kind: "task" })] },
    });
  });

  it("throws when a saved step factory is called after graph declaration closes", () => {
    let savedStep: StepFactory | undefined;
    let savedDeclaration: StepDeclaration | undefined;
    const definition = defineWorkflow({
      name: "saved_step_lifetime",
    }).build(({ step }) => {
      savedStep = step;
      savedDeclaration = step("cached");
      return {};
    });

    compileWorkflowDefinition(definition);

    expect(() => savedStep?.("bare_late")).toThrow(
      "step() can only be called during workflow graph declaration.",
    );
    expect(() => savedStep?.("late").task({
      input: {},
      exec: async () => ({}),
    })).toThrow("step() can only be called during workflow graph declaration.");
    expect(() => savedDeclaration?.task({
      input: {},
      exec: async () => ({}),
    })).toThrow("step() can only be called during workflow graph declaration.");
  });

  it("allows node output fields named ir to be wired as normal user fields", () => {
    const definition = defineWorkflow({ name: "output_ir_field" }).build(({ step }) => {
      const inspect = step("inspect").task({
        input: {},
        exec: async () => ({ ir: "ok" }),
      });

      return { ir: inspect.output.ir };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.output).toMatchObject({ kind: "object", fields: { ir: { kind: "ref", path: ["nodes", "inspect", "output", "ir"] } } });
    expect(ir.root.nodes[0]).not.toHaveProperty("outputSchema");
  });

  it("returns ordinary lowering failures without changing throwing-wrapper semantics", () => {
    const cause = Object.assign(new Error("build failed"), { code: "BUILD_FAILED" });
    const definition = defineWorkflow({ name: "throwing_build" }).build(() => {
      throw cause;
    });

    const result = tryCompileWorkflowDefinition(definition);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected lowering failure");
    expect(result.error).toEqual({
      type: "workflow-lowering-failed",
      message: "build failed",
      cause,
    });
    try {
      compileWorkflowDefinition(definition);
      throw new Error("expected throwing compilation wrapper to fail");
    } catch (error) {
      expect(error).toBe(cause);
    }
  });

  it("fails malformed Task specs instead of compiling an empty executable sentinel", () => {
    const definition = defineWorkflow({ name: "malformed_task" }).build(({ step }) => {
      step("bad_task").task({
        run: {
          input: {},
        },
      } as any);
      return {};
    });

    const result = tryCompileWorkflowDefinition(definition);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected malformed Task failure");
    expect(result.error).toEqual({
      type: "invalid-task-spec",
      nodeId: "bad_task",
      message: "Task node 'bad_task' must use inline { input, exec } or reusable { input, task }.",
    });
    expect(() => compileWorkflowDefinition(definition)).toThrow(
      "Task node 'bad_task' must use inline { input, exec } or reusable { input, task }.",
    );
  });

  it("requires and copies complete source links for reusable Tasks", () => {
    const definition = defineWorkflow({ name: "linked_task" }).build(({ step }) => {
      step("linked").task({ task: normalizePackage, input: { packageName: "acpus" } });
      return {};
    });

    for (const options of [undefined, { validate: false }]) {
      const result = tryCompileWorkflowDefinition(definition, options);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected missing reusable Task link");
      expect(result.error).toMatchObject({
        type: "reusable-task-target-missing",
        nodeId: "linked",
      });
    }
    try {
      compileWorkflowDefinition(definition);
      throw new Error("expected throwing compilation wrapper to fail");
    } catch (error) {
      expect((error as Error).cause).toMatchObject({
        type: "reusable-task-target-missing",
        nodeId: "linked",
      });
    }
    const invalid = tryCompileWorkflowDefinition(definition, {
      validate: false,
      reusableTasks: {
        referrerPath: "../release.ts",
        targets: new Map([["linked", { specifier: "./tasks.ts", exportName: "normalizePackage" }]]),
      },
    });
    expect(invalid.isErr()).toBe(true);
    if (invalid.isOk()) throw new Error("expected invalid reusable Task link");
    expect(invalid.error).toMatchObject({
      type: "reusable-task-target-invalid",
      nodeId: "linked",
      field: "referrerPath",
    });
    for (const path of [
      String.raw`\\server\share\workflow.ts`,
      String.raw`\\?\C:\workspace\workflow.ts`,
      String.raw`C:workflow.ts`,
    ]) {
      const rooted = tryCompileWorkflowDefinition(definition, {
        reusableTasks: {
          referrerPath: path,
          targets: new Map([["linked", { specifier: "./tasks.ts", exportName: "normalizePackage" }]]),
        },
      });
      expect(rooted.isErr()).toBe(true);
      if (rooted.isOk()) throw new Error("expected rooted reusable Task referrer failure");
      expect(rooted.error).toMatchObject({
        type: "reusable-task-target-invalid",
        field: "referrerPath",
      });
    }

    const link = { specifier: "./tasks.ts", exportName: "normalizePackage" };
    const plan = {
      referrerPath: "workflows/release.ts",
      targets: new Map([["linked", link]]),
    };
    const compiled = compileWorkflowDefinition(definition, { reusableTasks: plan });
    link.specifier = "./changed.ts";
    plan.referrerPath = "changed.ts";

    expect(compiled.root.nodes[0]).toMatchObject({
      run: {
        target: {
          kind: "module",
          specifier: "./tasks.ts",
          exportName: "normalizePackage",
          referrer: { path: "workflows/release.ts" },
        },
      },
    });
  });

  it("omits optional timeout fields and lowers loop transition output", () => {
    const Output = z.object({ ok: z.boolean() });
    const definition = defineWorkflow({ name: "default_fail_policies" }).build(({ step }) => {
      const signal = step("approval").signal({
        outputSchema: Output,
        timeout: "1m",
        prompt: "Approve?",
      });
      const loop = step("retry").loop({
        state: { ok: false as boolean },
        do() { return { state: { ok: true }, stop: true }; },
      });
      return { ok: signal.output.ok, loop_ok: loop.output.ok };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "approval",
      kind: "signal",
      timeout: { kind: "literal", value: "1m" },
    });
    expect(ir.root.nodes[0]).not.toHaveProperty("onTimeout");
    expect(ir.root.nodes[1]).toMatchObject({
      id: "retry",
      kind: "loop",
      do: {
        output: { kind: "object", fields: {
          state: { kind: "object", fields: { ok: { kind: "literal", value: true } } },
          stop: { kind: "literal", value: true },
        } },
      },
    });
    expect(ir.root.nodes[1]).not.toHaveProperty("onExhausted");
    expect(ir.root.nodes[1]).not.toHaveProperty("maxIterations");
    expect(ir.root.nodes[1]).not.toHaveProperty("stopWhen");
    expect(ir.root.nodes[1]).not.toHaveProperty("outputSchema");
  });

  it("lowers workflow-valued loop stop transition", () => {
    const definition = defineWorkflow({
      name: "dynamic_loop_limit",
      inputSchema: z.object({ rounds: z.number().default(1) }),
    }).build(({ input, step }) => {
      const loop = step("retry").loop({
        state: { ok: false as boolean },
        do({ round }) { return { state: { ok: true }, stop: lift(round, input.rounds, (value, limit) => value === limit) }; },
      });
      return { ok: loop.output.ok };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "retry",
      kind: "loop",
      do: {
        output: { kind: "object", fields: {
          stop: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["loop", "retry", "round"] },
              { kind: "ref", path: ["input", "rounds"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        } },
      },
    });
  });

  it("requires loop bodies to declare stop in the transition output", () => {
    const definition = defineWorkflow({ name: "counted_loop" }).build(({ step }) => {
      const loop = step("counted").loop({
        state: { ok: false as boolean },
        do() { return { state: { ok: true }, stop: true }; },
      });
      return { ok: loop.output.ok };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "counted",
      kind: "loop",
      do: {
        output: { kind: "object", fields: {
          stop: { kind: "literal", value: true },
        } },
      },
    });
  });

  it("lowers custom acpx command agent definitions and skips malformed agent definitions", () => {
    const valid = defineWorkflow({
      name: "command_agent_definition",
      agents: {
        worker: {
          command: "acpx worker",
          model: "gpt-5.4",
          permissionMode: "approve-all",
          config: { model: "gpt-5.5", mode: "bypassPermissions" },
          trace: false,
          cwd: "/tmp/work",
          env: {
            STATIC: "1",
          },
        },
      },
    }).build(({ agents, step }) => {
      step("run_worker").agent({
        agent: agents.worker,
        prompt: "Run worker",
      });
      return {};
    });

    const validIr = compileWorkflowDefinition(valid);

    expect(validIr.diagnostics).toEqual([]);
    expect(validIr.agents).toEqual({
      worker: {
        kind: "agent_command",
        command: "acpx worker",
        model: "gpt-5.4",
        permissionMode: "approve-all",
        config: { model: "gpt-5.5", mode: "bypassPermissions" },
        trace: false,
        cwd: "/tmp/work",
        env: {
          STATIC: "1",
        },
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
        legacy_agent_mode: { use: "codex", agentMode: "plan" },
        bad_config: { use: "codex", config: { mode: true } },
        bad_trace: { use: "codex", trace: "yes" },
      } as any,
    }).build(() => ({}));

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
      expect.objectContaining({
        code: "A002",
        path: "agents.legacy_agent_mode.agentMode",
      }),
      expect.objectContaining({
        code: "A002",
        path: "agents.bad_config.config.mode",
      }),
      expect.objectContaining({
        code: "A002",
        path: "agents.bad_trace.trace",
      }),
    ]);
  });

  it("compiles race and quorum strategy contracts", () => {
    const Item = z.object({ id: z.string() });
    const definition = defineWorkflow({
      name: "strategy_flow",
      inputSchema: z.object({
        items: z.array(Item),
      }),
    }).build(({ input, step }) => {
      const race = step("first_check").parallel({
        strategy: "race",
        branches: {
          fast() { return { id: "fast", ok: true }; },
          slow() { return { id: "slow", ok: true }; },
        },
      });

      const quorum = step("review_quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        do({ item }) { return { id: item.id, ok: true }; },
      });

      return {
        winner: race.output.winner,
        result: race.output.result,
        accepted: quorum.output,
      };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    const race = ir.root.nodes[0];
    expect(race).toMatchObject({
      id: "first_check",
      kind: "parallel",
      strategy: "race",
      branches: {
        fast: { output: { kind: "object", fields: { id: { kind: "literal", value: "fast" } } } },
        slow: { output: { kind: "object", fields: { id: { kind: "literal", value: "slow" } } } },
      },
    });
    expect((race as any).branches.fast).not.toHaveProperty("outputSchema");

    const quorum = ir.root.nodes[1];
    expect(quorum).toMatchObject({
      id: "review_quorum",
      kind: "fanout",
      strategy: "quorum",
      count: { kind: "literal", value: 2 },
    });
    expect(quorum).not.toHaveProperty("itemOutputSchema");
  });

  it("rejects undefined in plain workflow-data objects", () => {
    const withUndefined = defineWorkflow({ name: "strip_undefined" }).build((() => ({
      payload: {
        keep: true,
        drop: undefined,
        nested: { keep: "yes", drop: undefined },
      },
    })) as any);

    expect(() => compileWorkflowDefinition(withUndefined)).toThrow("Unsupported expression value at key 'drop': undefined.");

    const withDate = defineWorkflow({ name: "reject_non_plain_object" }).build((() => ({
      when: new Date(0),
    })) as any);

    expect(() => compileWorkflowDefinition(withDate)).toThrow("Unsupported expression value: non-plain object.");
  });

  it("accepts scalar scope outputs and fails invalid lowering invariants", () => {
    const undefinedRoot = defineWorkflow({ name: "undefined_root" }).build((() => undefined) as any);
    expect(() => compileWorkflowDefinition(undefinedRoot)).toThrow("Unsupported expression value: undefined.");

    const stringRoot = defineWorkflow({ name: "string_root" }).build((() => "ok") as any);
    expect(compileWorkflowDefinition(stringRoot).root.output).toEqual({ kind: "literal", value: "ok" });

    const exprRoot = defineWorkflow({ name: "expr_root" }).build((({ step }: any) => {
      const leaf = step("leaf").task({ input: {}, exec: async () => ({ value: "ok" }) });
      return leaf.output.value;
    }) as any);
    expect(compileWorkflowDefinition(exprRoot).root.output).toEqual({ kind: "ref", path: ["nodes", "leaf", "output", "value"] });

    const scalarBranches = defineWorkflow({ name: "scalar_branches" }).build((({ step }: any) => {
      step("gate").if({ condition: true, then: () => "ready", else: () => null });
      return {};
    }) as any);
    expect(compileWorkflowDefinition(scalarBranches).root.nodes[0]).toMatchObject({
      kind: "if",
      then: { output: { kind: "literal", value: "ready" } },
      else: { output: { kind: "literal", value: null } },
    });

    const directRef = defineWorkflow({ name: "direct_ref" }).build((({ step }: any) =>
      step("leaf").task({ input: {}, exec: async () => ({ value: "ok" }) })) as any);
    expect(() => compileWorkflowDefinition(directRef)).toThrow("NodeRef cannot be lowered as durable data");

    const nestedRef = defineWorkflow({ name: "nested_ref" }).build((({ step }: any) => {
      const leaf = step("leaf").task({ input: {}, exec: async () => ({ value: "ok" }) });
      return { leaf };
    }) as any);
    expect(() => compileWorkflowDefinition(nestedRef)).toThrow("NodeRef cannot be lowered as durable data");

    const malformedScope = defineWorkflow({ name: "malformed_scope" }).build((({ step }: any) => {
      step("gate").if({
        condition: true,
        then: (() => undefined) as any,
        else: () => ({ value: "ok" }),
      });
      return {};
    }) as any);
    expect(() => compileWorkflowDefinition(malformedScope)).toThrow("Unsupported expression value: undefined.");
  });
});
