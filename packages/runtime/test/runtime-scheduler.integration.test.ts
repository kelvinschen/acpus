import { describe, expect, it } from "vitest";
import { defineWorkflow, z } from "@acpus/core";
import { fmap, lift2, template } from "@acpus/expression";
import { compileWorkflowDefinition } from "@acpus/core/workflow";
import { executeWorkflow } from "../src/execution/scheduler.js";

describe("runtime non-agent scheduler skeleton", () => {
  it("executes assert, if, switch, parallel, fanout, and loop nodes", async () => {
    const definition = defineWorkflow({
      name: "non_agent_composites",
      inputSchema: z.object({
        items: z.array(z.string()),
        mode: z.string(),
        shouldRun: z.boolean(),
      }),
    }).build(({ input, step }) => {
      step("require_run").assert({ condition: input.shouldRun });

      const gate = step("gate").if({
        condition: input.shouldRun,
        then() { return { status: "run" }; },
        else() { return { status: "skip" }; },
      });

      const route = step("route").switch({
        cases: [
          { when: fmap(input.mode, mode => mode === "fast"), then() { return { code: "F" }; } },
        ],
        default() { return { code: "D" }; },
      });

      const checks = step("checks").parallel({
        branches: {
          fast() { return { status: gate.output.status }; },
          route() { return { code: route.output.code }; },
        },
      });

      const perItem = step("per_item").fanout({
        over: input.items,
        do({ item, itemIndex }) { return { label: item, index: itemIndex }; },
      });

      const retry = step("retry").loop({
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
        routeCode: checks.output.route.code,
        firstItem: fmap(perItem.output, items => items[0]?.label ?? "none"),
        done: retry.output.done,
        summary: retry.output.summary,
      };
    });
    const ir = compileWorkflowDefinition(definition);

    const result = await executeWorkflow(ir, {
      items: ["alpha", "beta"],
      mode: "fast",
      shouldRun: true,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      status: "run",
      fastStatus: "run",
      routeCode: "F",
      firstItem: "alpha",
      done: true,
      summary: "first",
    });
    expect(result.nodes.require_run).toEqual({ status: "completed", output: {} });
    expect(expectCompletedNode(result, "gate").status).toBe("completed");
    expect(expectCompletedNode(result, "gate").output).toEqual({ status: "run" });
    expect(expectCompletedNode(result, "route").output).toEqual({ code: "F" });
    expect(expectCompletedNode(result, "checks").output).toEqual({
      fast: { status: "run" },
      route: { code: "F" },
    });
    expect(expectCompletedNode(result, "per_item").output).toEqual([
      { label: "alpha", index: 0 },
      { label: "beta", index: 1 },
    ]);
    expect(expectCompletedNode(result, "retry").output).toEqual({ done: true, summary: "first" });
  });

  it("fails asserts and rejects executable nodes without an executor", async () => {
    const badCallbackAssert = compileWorkflowDefinition(defineWorkflow({
      name: "bad_callback_assert",
    }).build(({ step }) => {
      step("bad_callback").assert({ condition: fmap(true, _value => new Date() as any) });
      return {};
    }));

    await expect(executeWorkflow(badCallbackAssert, {})).rejects.toThrow("fmap(...) expected JSON-compatible values.");

    const failedAssert = compileWorkflowDefinition(defineWorkflow({
      name: "failed_assert",
    }).build(({ step }) => {
      step("nope").assert({ condition: false });
      return {};
    }));

    await expect(executeWorkflow(failedAssert, {})).rejects.toThrow("Assert node 'nope' failed.");

    const failedAssertWithMessage = compileWorkflowDefinition(defineWorkflow({
      name: "failed_assert_message",
      inputSchema: z.object({ name: z.string() }),
    }).build(({ input, step }) => {
      step("nope").assert({ condition: false, message: template`bad ${input.name}` });
      return {};
    }));

    await expect(executeWorkflow(failedAssertWithMessage, { name: "input" })).rejects.toThrow("Assert node 'nope' failed: bad input");

    const executable = compileWorkflowDefinition(defineWorkflow({
      name: "needs_executor",
    }).build(({ step }) => {
      step("work").task({
        run: { input: {}, exec: async () => ({ ok: true }) },
      });
      return {};
    }));

    await expect(executeWorkflow(executable, {})).rejects.toThrow("Executable node 'work' (task) requires a node executor.");

    const agent = compileWorkflowDefinition(defineWorkflow({
      name: "needs_agent_executor",
      agents: { reviewer: { use: "mock" } },
    }).build(({ agents, step }) => {
      step("review").agent({ run: { agent: agents.reviewer, prompt: "review" } });
      return {};
    }));
    await expect(executeWorkflow(agent, {})).rejects.toThrow("Executable node 'review' (agent) requires a node executor.");

    const signal = compileWorkflowDefinition(defineWorkflow({
      name: "needs_signal_executor",
    }).build(({ step }) => {
      step("approve").signal({ outputSchema: z.object({ ok: z.boolean() }), run: { prompt: "approve" } });
      return {};
    }));
    await expect(executeWorkflow(signal, {})).rejects.toThrow("Signal node 'approve' is awaiting payload.");
  });

  it("supports switch default and fanout quorum aggregation", async () => {
    const definition = defineWorkflow({
      name: "quorum_default",
      inputSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
    }).build(({ input, step }) => {
      const route = step("route").switch({
        cases: [
          { when: false, then() { return { code: "selected" }; } },
        ],
        default() { return { code: "default" }; },
      });
      const quorum = step("quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        do({ item }) { return { id: item.id, ok: fmap(item.id, id => /.+/.test(id)) }; },
      });
      return {
        code: route.output.code,
        accepted: quorum.output,
      };
    });
    const ir = compileWorkflowDefinition(definition);

    expect((await executeWorkflow(ir, {
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    })).output).toEqual({
      code: "default",
      accepted: [{ id: "a", ok: true }, { id: "b", ok: true }],
    });
  });

  it("orders direct fanout all output by input order when items complete out of order", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "direct_fanout_all_input_order",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step }) => {
      const all = step("items").fanout({
        over: input.items,
        do({ item }) {
          const work = step("work").task({
            run: { input: { item }, exec: async ({ input }) => ({ item: input.item }) },
          });
          return { item: work.output.item };
        },
      });
      return { items: all.output };
    }));

    const result = await executeWorkflow(ir, { items: ["slow", "fast", "middle"] }, {
      taskExecutor: async (_node, scope) => {
        const item = (scope.fanout as Record<string, { item: string }>).items?.item;
        if (item === "slow") await new Promise(resolve => setTimeout(resolve, 20));
        if (item === "middle") await new Promise(resolve => setTimeout(resolve, 10));
        return { item };
      },
    });

    expect(result.output).toEqual({
      items: [{ item: "slow" }, { item: "fast" }, { item: "middle" }],
    });
  });

  it("executes fanout body tasks declared through the build-provided step", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "closed_over_step_fanout",
      inputSchema: z.object({
        items: z.array(z.object({ id: z.string(), score: z.number() })),
      }),
    }).build(({ input, step }) => {
      const evaluated = step("evaluate_items").fanout({
        over: input.items,
        do({ item }) {
          const result = step("evaluate_item").task({
            run: {
              input: {
                id: item.id,
                score: item.score,
              },
              exec: async ({ input }) => ({
                id: input.id,
                score: input.score,
                message: `score:${input.score}`,
              }),
            },
          });
          return {
            id: result.output.id,
            score: result.output.score,
            message: result.output.message,
          };
        },
      });
      return { evaluated: evaluated.output };
    }));
    const fanout = ir.root.nodes.find((node) => node.id === "evaluate_items");

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "evaluate_item" }),
    ]));
    expect(fanout).toMatchObject({
      kind: "fanout",
      do: { nodes: [expect.objectContaining({ id: "evaluate_item", kind: "task" })] },
    });

    const result = await executeWorkflow(ir, {
      items: [{ id: "a", score: 10 }, { id: "b", score: 20 }],
    }, {
      taskExecutor: async (_node, scope) => {
        const item = (scope.fanout as Record<string, { item?: { id: string; score: number } }>).evaluate_items?.item;
        return {
          id: item?.id,
          score: item?.score,
          message: `score:${item?.score}`,
        };
      },
    });

    expect(result.output).toEqual({
      evaluated: [
        { id: "a", score: 10, message: "score:10" },
        { id: "b", score: 20, message: "score:20" },
      ],
    });
  });

  it("orders direct fanout quorum output by completion order", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "direct_quorum_completion_order",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step }) => {
      const quorum = step("items").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        do({ item }) {
          const work = step("work").task({
            run: { input: { item }, exec: async ({ input }) => ({ item: input.item }) },
          });
          return { item: work.output.item };
        },
      });
      return { accepted: quorum.output };
    }));

    const result = await executeWorkflow(ir, { items: ["slow", "fast", "middle"] }, {
      taskExecutor: async (_node, scope) => {
        const item = (scope.fanout as Record<string, { item: string }>).items?.item;
        if (item === "slow") await new Promise(resolve => setTimeout(resolve, 20));
        if (item === "middle") await new Promise(resolve => setTimeout(resolve, 10));
        return { item };
      },
    });

    expect(result.output).toEqual({
      accepted: [{ item: "fast" }, { item: "middle" }],
    });
  });

  it("executes if else branches without leaking branch-local nodes", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "if_else_isolation",
      inputSchema: z.object({ shouldRun: z.boolean() }),
    }).build(({ input, step }) => {
      const gate = step("gate").if({
        condition: input.shouldRun,
        then() {
          step("then_internal").assert({ condition: true });
          return { status: "run" };
        },
        else() {
          step("else_internal").assert({ condition: true });
          return { status: "skip" };
        },
      });
      return { status: gate.output.status };
    }));

    const result = await executeWorkflow(ir, { shouldRun: false });

    expect(result.output).toEqual({ status: "skip" });
    expect(expectCompletedNode(result, "gate").output).toEqual({ status: "skip" });
    expect(result.nodes).not.toHaveProperty("then_internal");
    expect(result.nodes).not.toHaveProperty("else_internal");
  });

  it("isolates parallel branch-local nodes from sibling branches and parent scope", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "parallel_isolation",
    }).build(({ step }) => {
      const composite = step("composite").parallel({
        branches: {
          left() {
            step("left_internal").assert({ condition: true });
            return { ok: true };
          },
          right() { return { ok: true }; },
        },
      });
      return { left: composite.output.left.ok, right: composite.output.right.ok };
    }));

    const result = await executeWorkflow(ir, {});

    expect(result.output).toEqual({ left: true, right: true });
    expect(expectCompletedNode(result, "composite").output).toEqual({ left: { ok: true }, right: { ok: true } });
    expect(result.nodes).not.toHaveProperty("left_internal");
  });

  it("handles loop carried state and explicit stop", async () => {
    const counted = compileWorkflowDefinition(defineWorkflow({
      name: "loop_counted_stop",
    }).build(({ step }) => {
      const loop = step("retry").loop({
        state: { index: -1, previousIndex: -1 },
        do({ index, state, round }) { return {
          state: {
            index,
            previousIndex: state.index,
          },
          stop: fmap(round, value => value === 3),
        }; },
      });
      return { index: loop.output.index, previousIndex: loop.output.previousIndex };
    }));

    expect((await executeWorkflow(counted, {})).output).toEqual({ index: 2, previousIndex: 1 });

    const once = compileWorkflowDefinition(defineWorkflow({
      name: "loop_runs_once",
    }).build(({ step }) => {
      const loop = step("retry").loop({
        state: { ok: false as boolean },
        do() { return { state: { ok: true }, stop: true }; },
      });
      return { ok: loop.output.ok };
    }));
    expect((await executeWorkflow(once, {})).output).toEqual({ ok: true });
  });

  it("fails non-boolean conditions and supports parallel race", async () => {
    const badAssert = compileWorkflowDefinition(defineWorkflow({
      name: "bad_assert_condition",
    }).build(({ step }) => {
      step("bad").assert({ condition: "yes" as any });
      return {};
    }));
    await expect(executeWorkflow(badAssert, {})).rejects.toThrow("Node 'bad' condition must evaluate to boolean.");

    const badLoop = compileWorkflowDefinition(defineWorkflow({
      name: "bad_loop_condition",
    }).build(({ step }) => {
      step("loop").loop({
        state: { ok: false as boolean },
        do() { return { state: { ok: true }, stop: "yes" as any }; },
      });
      return {};
    }));
    await expect(executeWorkflow(badLoop, {})).rejects.toThrow("Loop node 'loop' body transition 'stop' must be boolean.");

    const race = compileWorkflowDefinition(defineWorkflow({
      name: "race_supported",
    }).build(({ step }) => {
      const winner = step("race").parallel({
        strategy: "race",
        branches: {
          left() { return { value: "left" }; },
          right() { return { value: "right" }; },
        },
      });
      return { winner: winner.output.winner, value: winner.output.result.value };
    }));
    expect((await executeWorkflow(race, {})).output).toEqual({ winner: "left", value: "left" });

    const pureFailover = compileWorkflowDefinition(defineWorkflow({
      name: "race_pure_failover",
    }).build(({ step }) => {
      const winner = step("race").parallel({
        strategy: "race",
        branches: {
          left() {
            step("fail_left").assert({ condition: false });
            return { value: "left" };
          },
          right() { return { value: "right" }; },
        },
      });
      return { winner: winner.output.winner, value: winner.output.result.value };
    }));
    expect((await executeWorkflow(pureFailover, {})).output).toEqual({ winner: "right", value: "right" });

    const pureAllFail = compileWorkflowDefinition(defineWorkflow({
      name: "race_pure_all_fail",
    }).build(({ step }) => {
      step("race").parallel({
        strategy: "race",
        branches: {
          left() {
            step("fail_left").assert({ condition: false });
            return { value: "left" };
          },
          right() {
            step("fail_right").assert({ condition: false });
            return { value: "right" };
          },
        },
      });
      return {};
    }));
    await expect(executeWorkflow(pureAllFail, {})).rejects.toThrow("Parallel race node 'race' had no successful branches.");

    const executableRace = compileWorkflowDefinition(defineWorkflow({
      name: "race_executable_first_success",
    }).build(({ step }) => {
      const race = step("race").parallel({
        strategy: "race",
        branches: {
          slow() {
            const result = step("slow_task").task({
              run: {
                input: { label: "slow" },
                exec: async ({ input }) => ({ label: input.label }),
              },
            });
            return { label: result.output.label };
          },
          fast() {
            const result = step("fast_task").task({
              run: {
                input: { label: "fast" },
                exec: async ({ input }) => ({ label: input.label }),
              },
            });
            return { label: result.output.label };
          },
        },
      });
      return { winner: race.output.winner, label: race.output.result.label };
    }));
    const fastWins = await executeWorkflow(executableRace, {}, {
      taskExecutor: async node => {
        if (node.id === "slow_task") await new Promise(resolve => setTimeout(resolve, 20));
        return { label: node.id === "fast_task" ? "fast" : "slow" };
      },
    });
    expect(fastWins.output).toEqual({ winner: "fast", label: "fast" });
    expect(Object.keys(fastWins.executedNodes).sort()).toEqual(["fast_task", "race"]);

    const failover = await executeWorkflow(executableRace, {}, {
      taskExecutor: async node => {
        if (node.id === "slow_task") throw new Error("slow failed");
        return { label: "fast" };
      },
    });
    expect(failover.output).toEqual({ winner: "fast", label: "fast" });
  });

  it("handles fanout empty input, non-array input, and impossible quorum", async () => {
    const emptyFanout = compileWorkflowDefinition(defineWorkflow({
      name: "empty_fanout",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step }) => {
      const fanout = step("per_item").fanout({
        over: input.items,
        do() { return { ok: true }; },
      });
      return { items: fanout.output };
    }));
    const emptyResult = await executeWorkflow(emptyFanout, { items: [] });
    expect(expectCompletedNode(emptyResult, "per_item").output).toEqual([]);

    const nonArrayFanout = compileWorkflowDefinition(defineWorkflow({
      name: "bad_fanout",
    }).build(({ step }) => {
      step("per_item").fanout({
        over: "not-array" as any,
        do() { return { ok: true }; },
      });
      return {};
    }));
    await expect(executeWorkflow(nonArrayFanout, {})).rejects.toThrow("Fanout node 'per_item' expected array input.");

    const impossibleQuorum = compileWorkflowDefinition(defineWorkflow({
      name: "impossible_quorum",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step }) => {
      step("quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        do() { return { ok: true }; },
      });
      return {};
    }));
    await expect(executeWorkflow(impossibleQuorum, { items: ["a"] })).rejects.toThrow("Fanout quorum node 'quorum' accepted 1 items, below required count 2.");
  });

  it("rejects non-string schema-less signal payloads in direct execution", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "raw_signal_payload",
    }).build(({ step }) => {
      const approval = step("approve").signal({ run: { prompt: "approve" } });
      return { approval: approval.output };
    }));

    await expect(executeWorkflow(ir, {}, {
      signalPayloads: { approve: { approved: true } },
    })).rejects.toThrow("Signal node 'approve' payload must be a string.");

    await expect(executeWorkflow(ir, {}, {
      signalPayloads: { approve: "approved" },
    })).resolves.toMatchObject({ output: { approval: "approved" } });
  });

  it("rejects non-admissible task output before it enters direct scheduler scope", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({ name: "bad_task_output" }).build(({ step }) => {
      const task = step("bad").task({
        run: { input: {}, exec: async () => ({ when: new Date() }) },
      });
      return { when: task.output.when };
    }));

    await expect(executeWorkflow(ir, {}, {
      taskExecutor: async () => ({ when: new Date() }),
    })).rejects.toThrow("Node 'bad' output is not workflow-admissible");
  });

  it("rejects seeded completed node output and non-finite numbers before direct execution scope", async () => {
    const seeded = compileWorkflowDefinition(defineWorkflow({ name: "seeded_bad_output" }).build(({ step }) => {
      const task = step("seeded").task({
        run: { input: {}, exec: async () => ({ value: "ok" }) },
      });
      return { value: task.output.value };
    }));

    await expect(executeWorkflow(seeded, {}, {
      completedNodes: { seeded: { value: new Date() } },
    })).rejects.toThrow("Completed node 'seeded' output is not workflow-admissible");

    const nonFinite = compileWorkflowDefinition(defineWorkflow({ name: "non_finite_output" }).build(({ step }) => {
      const task = step("bad").task({
        run: { input: {}, exec: async () => ({ value: Number.NaN }) },
      });
      return { value: task.output.value };
    }));

    await expect(executeWorkflow(nonFinite, {}, {
      taskExecutor: async () => ({ value: Number.POSITIVE_INFINITY }),
    })).rejects.toThrow("non-finite number");
  });
});

type RuntimeResult = Awaited<ReturnType<typeof executeWorkflow>>;

function expectCompletedNode(result: RuntimeResult, id: string): RuntimeResult["nodes"][string] {
  const node = result.nodes[id];
  expect(node).toBeDefined();
  if (!node) throw new Error(`expected node '${id}' to be completed`);
  return node;
}
