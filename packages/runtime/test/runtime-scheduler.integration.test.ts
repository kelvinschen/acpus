import { describe, expect, it } from "vitest";
import { defineWorkflow, template, z } from "@acpus/core";
import { eq, fallback, head, literal, matches, or, where } from "@acpus/core/expression";
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
    }).build(({ input, step, output }) => {
      step("require_run").assert({ condition: input.shouldRun });

      const gate = step("gate").if({
        condition: input.shouldRun,
        outputSchema: z.object({ status: z.string() }),
        then: ({ output }) => output({ status: "run" }),
        else: ({ output }) => output({ status: "skip" }),
      });

      const route = step("route").switch({
        outputSchema: z.object({ code: z.string() }),
        cases: [
          { when: eq(input.mode, "fast"), then: ({ output }) => output({ code: "F" }) },
        ],
        default: ({ output }) => output({ code: "D" }),
      });

      const checks = step("checks").parallel({
        branches: {
          fast: {
            outputSchema: z.object({ status: z.string() }),
            do: ({ output }) => output({ status: gate.output.status }),
          },
          route: {
            outputSchema: z.object({ code: z.string() }),
            do: ({ output }) => output({ code: route.output.code }),
          },
        },
      });

      const perItem = step("per_item").fanout({
        over: input.items,
        itemOutputSchema: z.object({ label: z.string(), index: z.number() }),
        do: ({ item, itemIndex, output }) => output({ label: item, index: itemIndex }),
      });

      const retry = step("retry").loop({
        maxIterations: 3,
        outputSchema: z.object({ done: z.boolean(), summary: z.string() }),
        do: ({ iter, previous, output }) => output({
          done: eq(iter, 2),
          summary: fallback(previous.summary, "first"),
        }),
        stopWhen: ({ iter, result }) => or(eq(iter, 3), where(result, { done: true })),
        onExhausted: "returnLast",
      });

      return output({
        status: gate.output.status,
        fastStatus: checks.output.fast.status,
        routeCode: checks.output.route.code,
        firstItem: fallback(head(perItem.output).label, "none"),
        done: retry.output.done,
        summary: retry.output.summary,
      });
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
    const failedAssert = compileWorkflowDefinition(defineWorkflow({
      name: "failed_assert",
    }).build(({ step, output }) => {
      step("nope").assert({ condition: false });
      return output({});
    }));

    await expect(executeWorkflow(failedAssert, {})).rejects.toThrow("Assert node 'nope' failed.");

    const failedAssertWithMessage = compileWorkflowDefinition(defineWorkflow({
      name: "failed_assert_message",
      inputSchema: z.object({ name: z.string() }),
    }).build(({ input, step, output }) => {
      step("nope").assert({ condition: false, message: template`bad ${input.name}` });
      return output({});
    }));

    await expect(executeWorkflow(failedAssertWithMessage, { name: "input" })).rejects.toThrow("Assert node 'nope' failed: bad input");

    const executable = compileWorkflowDefinition(defineWorkflow({
      name: "needs_executor",
    }).build(({ step, output }) => {
      step("work").task({
        outputSchema: z.object({ ok: z.boolean() }),
        run: { input: {}, exec: async () => ({ ok: true }) },
      });
      return output({});
    }));

    await expect(executeWorkflow(executable, {})).rejects.toThrow("Executable node 'work' (task) requires a node executor.");

    const agent = compileWorkflowDefinition(defineWorkflow({
      name: "needs_agent_executor",
      agents: { reviewer: { use: "mock" } },
    }).build(({ agents, step, output }) => {
      step("review").agent({ run: { agent: agents.reviewer, prompt: "review" } });
      return output({});
    }));
    await expect(executeWorkflow(agent, {})).rejects.toThrow("Executable node 'review' (agent) requires a node executor.");

    const signal = compileWorkflowDefinition(defineWorkflow({
      name: "needs_signal_executor",
    }).build(({ step, output }) => {
      step("approve").signal({ outputSchema: z.object({ ok: z.boolean() }), run: { prompt: "approve" } });
      return output({});
    }));
    await expect(executeWorkflow(signal, {})).rejects.toThrow("Signal node 'approve' is awaiting payload.");
  });

  it("supports switch default and fanout quorum aggregation", async () => {
    const definition = defineWorkflow({
      name: "quorum_default",
      inputSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
    }).build(({ input, step, output }) => {
      const route = step("route").switch({
        outputSchema: z.object({ code: z.string() }),
        cases: [
          { when: false, then: ({ output }) => output({ code: "selected" }) },
        ],
        default: ({ output }) => output({ code: "default" }),
      });
      const quorum = step("quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        itemOutputSchema: z.object({ id: z.string(), ok: z.boolean() }),
        do: ({ item, output }) => output({ id: item.id, ok: matches(item.id, ".+") }),
      });
      return output({
        code: route.output.code,
        accepted: quorum.output.accepted,
        completed: quorum.output.completed,
      });
    });
    const ir = compileWorkflowDefinition(definition);

    expect((await executeWorkflow(ir, {
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    })).output).toEqual({
      code: "default",
      accepted: [{ id: "a", ok: true }, { id: "b", ok: true }],
      completed: [{ id: "a", ok: true }, { id: "b", ok: true }, { id: "c", ok: true }],
    });
  });

  it("executes if else branches without leaking branch-local nodes", async () => {
    const ir = compileWorkflowDefinition(defineWorkflow({
      name: "if_else_isolation",
      inputSchema: z.object({ shouldRun: z.boolean() }),
    }).build(({ input, step, output }) => {
      const gate = step("gate").if({
        condition: input.shouldRun,
        outputSchema: z.object({ status: z.string() }),
        then: ({ step, output }) => {
          step("then_internal").assert({ condition: true });
          return output({ status: "run" });
        },
        else: ({ step, output }) => {
          step("else_internal").assert({ condition: true });
          return output({ status: "skip" });
        },
      });
      return output({ status: gate.output.status });
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
    }).build(({ step, output }) => {
      const composite = step("composite").parallel({
        branches: {
          left: {
            outputSchema: z.object({ ok: z.boolean() }),
            do: ({ step, output }) => {
              step("left_internal").assert({ condition: true });
              return output({ ok: true });
            },
          },
          right: {
            outputSchema: z.object({ ok: z.boolean() }),
            do: ({ output }) => output({ ok: true }),
          },
        },
      });
      return output({ left: composite.output.left.ok, right: composite.output.right.ok });
    }));

    const result = await executeWorkflow(ir, {});

    expect(result.output).toEqual({ left: true, right: true });
    expect(expectCompletedNode(result, "composite").output).toEqual({ left: { ok: true }, right: { ok: true } });
    expect(result.nodes).not.toHaveProperty("left_internal");
  });

  it("handles loop previous output, returnLast exhaustion, and fail exhaustion", async () => {
    const returnLast = compileWorkflowDefinition(defineWorkflow({
      name: "loop_return_last",
    }).build(({ step, output }) => {
      const loop = step("retry").loop({
        maxIterations: 3,
        outputSchema: z.object({ iter: z.number(), previousIter: z.number() }),
        do: ({ iter, previous, output }) => output({
          iter,
          previousIter: fallback(previous.iter, -1),
        }),
        stopWhen: () => false,
        onExhausted: "returnLast",
      });
      return output({ iter: loop.output.iter, previousIter: loop.output.previousIter });
    }));

    expect((await executeWorkflow(returnLast, {})).output).toEqual({ iter: 2, previousIter: 1 });

    const fail = compileWorkflowDefinition(defineWorkflow({
      name: "loop_fail",
    }).build(({ step, output }) => {
      step("retry").loop({
        maxIterations: 2,
        outputSchema: z.object({ ok: z.boolean() }),
        do: ({ output }) => output({ ok: false }),
        stopWhen: () => false,
      });
      return output({});
    }));
    await expect(executeWorkflow(fail, {})).rejects.toThrow("Loop node 'retry' exhausted after 2 iterations.");
  });

  it("fails non-boolean conditions and supports parallel race", async () => {
    const badAssert = compileWorkflowDefinition(defineWorkflow({
      name: "bad_assert_condition",
    }).build(({ step, output }) => {
      step("bad").assert({ condition: literal("yes") as any });
      return output({});
    }));
    await expect(executeWorkflow(badAssert, {})).rejects.toThrow("Node 'bad' condition must evaluate to boolean.");

    const badLoop = compileWorkflowDefinition(defineWorkflow({
      name: "bad_loop_condition",
    }).build(({ step, output }) => {
      step("loop").loop({
        maxIterations: 1,
        outputSchema: z.object({ ok: z.boolean() }),
        do: ({ output }) => output({ ok: true }),
        stopWhen: () => "yes" as any,
      });
      return output({});
    }));
    await expect(executeWorkflow(badLoop, {})).rejects.toThrow("Node 'loop' condition must evaluate to boolean.");

    const race = compileWorkflowDefinition(defineWorkflow({
      name: "race_supported",
    }).build(({ step, output }) => {
      const winner = step("race").parallel({
        strategy: "race",
        branches: {
          left: { outputSchema: z.object({ value: z.string() }), do: ({ output }) => output({ value: "left" }) },
          right: { outputSchema: z.object({ value: z.string() }), do: ({ output }) => output({ value: "right" }) },
        },
      });
      return output({ winner: winner.output.winner, value: winner.output.result.value });
    }));
    expect((await executeWorkflow(race, {})).output).toEqual({ winner: "left", value: "left" });

    const pureFailover = compileWorkflowDefinition(defineWorkflow({
      name: "race_pure_failover",
    }).build(({ step, output }) => {
      const winner = step("race").parallel({
        strategy: "race",
        branches: {
          left: {
            outputSchema: z.object({ value: z.string() }),
            do: ({ step, output }) => {
              step("fail_left").assert({ condition: false });
              return output({ value: "left" });
            },
          },
          right: { outputSchema: z.object({ value: z.string() }), do: ({ output }) => output({ value: "right" }) },
        },
      });
      return output({ winner: winner.output.winner, value: winner.output.result.value });
    }));
    expect((await executeWorkflow(pureFailover, {})).output).toEqual({ winner: "right", value: "right" });

    const pureAllFail = compileWorkflowDefinition(defineWorkflow({
      name: "race_pure_all_fail",
    }).build(({ step, output }) => {
      step("race").parallel({
        strategy: "race",
        branches: {
          left: { outputSchema: z.object({ value: z.string() }), do: ({ step, output }) => {
            step("fail_left").assert({ condition: false });
            return output({ value: "left" });
          } },
          right: { outputSchema: z.object({ value: z.string() }), do: ({ step, output }) => {
            step("fail_right").assert({ condition: false });
            return output({ value: "right" });
          } },
        },
      });
      return output({});
    }));
    await expect(executeWorkflow(pureAllFail, {})).rejects.toThrow("Parallel race node 'race' had no successful branches.");

    const calls: string[] = [];
    const executableRace = compileWorkflowDefinition(defineWorkflow({
      name: "race_executable_safe",
    }).build(({ step, output }) => {
      const race = step("race").parallel({
        strategy: "race",
        branches: {
          first: {
            outputSchema: z.object({ ok: z.boolean() }),
            do: ({ step, output }) => {
              const result = step("first_task").task({
                outputSchema: z.object({ ok: z.boolean() }),
                run: { input: {}, exec: async () => {
                  calls.push("first");
                  return { ok: true };
                } },
              });
              return output({ ok: result.output.ok });
            },
          },
          second: {
            outputSchema: z.object({ ok: z.boolean() }),
            do: ({ step, output }) => {
              const result = step("second_task").task({
                outputSchema: z.object({ ok: z.boolean() }),
                run: { input: {}, exec: async () => {
                  calls.push("second");
                  return { ok: true };
                } },
              });
              return output({ ok: result.output.ok });
            },
          },
        },
      });
      return output({ winner: race.output.winner, ok: race.output.result.ok });
    }));
    const firstWins = await executeWorkflow(executableRace, {}, {
      taskExecutor: async node => {
        calls.push(node.id);
        return { ok: true };
      },
    });
    expect(firstWins.output).toEqual({ winner: "first", ok: true });
    expect(Object.keys(firstWins.executedNodes).sort()).toEqual(["first_task", "race"]);
    expect(calls).toEqual(["first_task"]);

    calls.length = 0;
    await expect(executeWorkflow(executableRace, {}, {
      taskExecutor: async node => {
        calls.push(node.id);
        if (node.id === "first_task") throw new Error("first failed");
        return { ok: true };
      },
    })).rejects.toThrow("first failed");
    expect(calls).toEqual(["first_task"]);
  });

  it("handles fanout empty input, non-array input, and impossible quorum", async () => {
    const emptyFanout = compileWorkflowDefinition(defineWorkflow({
      name: "empty_fanout",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step, output }) => {
      const fanout = step("per_item").fanout({
        over: input.items,
        itemOutputSchema: z.object({ ok: z.boolean() }),
        do: ({ output }) => output({ ok: true }),
      });
      return output({ items: fanout.output });
    }));
    const emptyResult = await executeWorkflow(emptyFanout, { items: [] });
    expect(expectCompletedNode(emptyResult, "per_item").output).toEqual([]);

    const nonArrayFanout = compileWorkflowDefinition(defineWorkflow({
      name: "bad_fanout",
    }).build(({ step, output }) => {
      step("per_item").fanout({
        over: "not-array" as any,
        itemOutputSchema: z.object({ ok: z.boolean() }),
        do: ({ output }) => output({ ok: true }),
      });
      return output({});
    }));
    await expect(executeWorkflow(nonArrayFanout, {})).rejects.toThrow("Fanout node 'per_item' expected array input.");

    const impossibleQuorum = compileWorkflowDefinition(defineWorkflow({
      name: "impossible_quorum",
      inputSchema: z.object({ items: z.array(z.string()) }),
    }).build(({ input, step, output }) => {
      step("quorum").fanout({
        strategy: "quorum",
        count: 2,
        over: input.items,
        itemOutputSchema: z.object({ ok: z.boolean() }),
        do: ({ output }) => output({ ok: true }),
      });
      return output({});
    }));
    await expect(executeWorkflow(impossibleQuorum, { items: ["a"] })).rejects.toThrow("Fanout quorum node 'quorum' accepted 1 items, below required count 2.");
  });
});

type RuntimeResult = Awaited<ReturnType<typeof executeWorkflow>>;

function expectCompletedNode(result: RuntimeResult, id: string): RuntimeResult["nodes"][string] {
  const node = result.nodes[id];
  expect(node).toBeDefined();
  if (!node) throw new Error(`expected node '${id}' to be completed`);
  return node;
}
