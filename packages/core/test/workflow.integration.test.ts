import { describe, expect, it } from "vitest";
import {
  defineWorkflow,
  task,
  type StepDeclaration,
  type StepFactory,
  z,
} from "../src/index.js";
import { compileWorkflowDefinition } from "../src/workflow.js";
import { fmap, lift2, template } from "@acpus/expression";

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
          agentMode: "agent",
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
        condition: fmap(tests.output, output => output.passed === true),
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

    const ir = compileWorkflowDefinition(definition, { validate: false });

    expect(ir.diagnostics).toEqual([]);
    expect(ir.irVersion).toBe(4);
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
        agentMode: "agent",
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
          specifier: "",
          exportName: "",
          referrer: { path: "" },
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
        fn: "fmap",
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
      runId: { kind: "ref", path: ["meta", "runId"] },
    });
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
    }).build((() => ({ omitted: undefined })) as any))).toThrow("Unsupported expression value: undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({
      name: "reject_nested_undefined_outputs",
    }).build((() => ({ payload: { kept: "nested", omitted: undefined } })) as any))).toThrow("Unsupported expression value at key 'omitted': undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({ name: "reject_undefined_task_input" }).build(({ step }) => {
      step("task").task({
        input: { omitted: undefined as any }, exec: async () => ({}),
      });
      return {};
    }))).toThrow("Unsupported expression value: undefined.");

    expect(() => compileWorkflowDefinition(defineWorkflow({ name: "reject_undefined_composite_output" }).build(({ step }) => {
      step("parallel").parallel({
        branches: { only: (() => ({ omitted: undefined })) as any },
      });
      return {};
    }))).toThrow("Unsupported expression value: undefined.");
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
        do({ item }) { return { ok: fmap(item, value => /.+/.test(value)) }; },
        maxConcurrency: 4,
      });

      const retry = step("retry_until_done").loop({
        state: { done: false as boolean, summary: "first" },
        do({ round, state }) { return {
            state: {
              done: fmap(round, value => value === 3),
              summary: state.summary,
            },
            stop: lift2(round, state.done, (value, done) => value === 3 || done === true),
          }; },
      });

      return {
        status: gate.output.status,
        fastStatus: checks.output.fast.status,
        firstItemOk: fmap(perItem.output, items => items[0]?.ok ?? false),
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
          outputs: {
            status: {
              kind: "ref",
              path: ["nodes", "gate", "output", "status"],
            },
          },
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
        outputs: {
          ok: {
            kind: "call",
            fn: "fmap",
            args: [
              { kind: "ref", path: ["fanout", "per_item", "item"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        },
      },
    });
    expect(ir.root.nodes[2]).not.toHaveProperty("itemOutputSchema");
    expect(ir.root.nodes[2]).not.toHaveProperty("outputSchema");
    expect(ir.outputs).toMatchObject({
      fastStatus: {
        kind: "ref",
        path: ["nodes", "checks", "output", "fast", "status"],
      },
      firstItemOk: {
        kind: "call",
        fn: "fmap",
        args: [
          { kind: "ref", path: ["nodes", "per_item", "output"] },
          { kind: "literal", value: expect.any(String) },
        ],
      },
    });
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
        outputs: {
          state: {
            kind: "object",
            fields: {
              done: {
                kind: "call",
                fn: "fmap",
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
            fn: "lift2",
            args: [
              { kind: "ref", path: ["loop", "retry_until_done", "round"] },
              { kind: "ref", path: ["loop", "retry_until_done", "state", "done"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        },
      },
    });
    expect(ir.root.nodes[3]).not.toHaveProperty("outputSchema");
    expect(ir.root.nodes[3]).not.toHaveProperty("until");
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

      return { first: fmap(fanout.output, items => items[0]?.value ?? null) };
    });

    const ir = compileWorkflowDefinition(definition);
    const fanout = ir.root.nodes.find((node) => node.id === "per_item");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fanout_echo" }),
    ]));
    expect(fanout).toMatchObject({
      kind: "fanout",
      do: { nodes: [expect.objectContaining({ id: "fanout_echo", kind: "task" })] },
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
        left: { nodes: [expect.objectContaining({ id: "parallel_left_echo", kind: "task" })] },
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
      then: { nodes: [expect.objectContaining({ id: "if_then_echo", kind: "task" })] },
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
      then: { nodes: [expect.objectContaining({ id: "cached_echo", kind: "task" })] },
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
        { then: { nodes: [expect.objectContaining({ id: "switch_case_echo", kind: "task" })] } },
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
      do: { nodes: [expect.objectContaining({ id: "loop_echo", kind: "task" })] },
    });
  });

  it("diagnoses thenable composite callbacks as invalid synchronous outputs", () => {
    const build = (({ step }: any) => {
      step("gate").if({
        condition: true,
        async then() { return { value: "async" }; },
        else() { return { value: "sync" }; },
      });
      return {};
    }) as any;

    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "async_composite_callback",
    }).build(build));

    expect(ir.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "B001",
        message: "Composite scope must return an output object.",
      }),
    ]));
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
    expect(ir.outputs.ir).toEqual({ kind: "ref", path: ["nodes", "inspect", "output", "ir"] });
    expect(ir.root.nodes[0]).not.toHaveProperty("outputSchema");
  });

  it("diagnoses malformed task specs without crashing compilation", () => {
    const definition = defineWorkflow({ name: "malformed_task" }).build(({ step }) => {
      step("bad_task").task({
        run: {
          input: {},
        },
      } as any);
      return {};
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "T000",
      severity: "error",
    }));
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "T007",
      path: "root.nodes.bad_task.run.target.source",
    }));
    expect(ir.root.nodes[0]).toMatchObject({
      id: "bad_task",
      kind: "task",
      run: {
        input: {},
        target: { kind: "inline", source: "" },
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
        outputs: {
          state: { kind: "object", fields: { ok: { kind: "literal", value: true } } },
          stop: { kind: "literal", value: true },
        },
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
        do({ round }) { return { state: { ok: true }, stop: lift2(round, input.rounds, (value, limit) => value === limit) }; },
      });
      return { ok: loop.output.ok };
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "retry",
      kind: "loop",
      do: {
        outputs: {
          stop: {
            kind: "call",
            fn: "lift2",
            args: [
              { kind: "ref", path: ["loop", "retry", "round"] },
              { kind: "ref", path: ["input", "rounds"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        },
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
        outputs: {
          stop: { kind: "literal", value: true },
        },
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
          agentMode: "bypassPermissions",
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
        agentMode: "bypassPermissions",
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
        fast: { outputs: { id: { kind: "literal", value: "fast" } } },
        slow: { outputs: { id: { kind: "literal", value: "slow" } } },
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

    const withDate = defineWorkflow({ name: "reject_non_plain_object" }).build(() => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      when: new Date(0) as any,
    }));

    expect(() => compileWorkflowDefinition(withDate)).toThrow("Unsupported expression value: non-plain object.");
  });
});
