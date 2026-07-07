import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, z, type OutputValues } from "../src/index.js";
import { get, head, type Expr } from "@acpus/expression";

test("loop initial defines non-optional previous and output shape", () => {
  defineWorkflow({ name: "typed-loop-output" }).build(({ step }) => {
    const loop = step("loop").loop({
      initial: { done: false as boolean, summary: "seed" },
      maxIterations: 2,
      do: ({ previous, iter }) => {
        expectTypeOf(previous.summary).toEqualTypeOf<Expr<string>>();
        expectTypeOf(iter).toEqualTypeOf<Expr<number>>();
        return {
          done: false,
          summary: previous.summary,
        };
      },
      stopWhen: ({ result }) => result.done,
    });

    expectTypeOf(loop.output.done).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(loop.output.summary).toEqualTypeOf<Expr<string>>();

    type Phase = "pending" | "done";
    const state = step("state").loop({
      initial: { done: false, phase: "pending" as Phase },
      maxIterations: 2,
      do: ({ previous }) => ({
        done: false,
        phase: previous.phase,
      }),
      stopWhen: ({ result }) => result.done,
    });
    expectTypeOf(state.output.done).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(state.output.phase).toEqualTypeOf<Expr<Phase>>();

    const counted = step("counted").loop({
      initial: { ok: false as boolean },
      maxIterations: 2,
      do: () => ({ ok: true }),
    });
    expectTypeOf(counted.output.ok).toEqualTypeOf<Expr<boolean>>();

    step("missing_required").loop({
      initial: { done: false, summary: "seed" },
      maxIterations: 2,
      // @ts-expect-error loop do result must converge with initial shape.
      do: () => ({ done: false }),
      stopWhen: ({ result }) => result.done,
    });

    return { done: loop.output.done, summary: loop.output.summary };
  });
});

test("control-only and output-producing if/switch require fallbacks", () => {
  defineWorkflow({ name: "typed-composite-output-paths" }).build(({ step }) => {
    step("control_only_if").if({
      condition: true,
      then: () => ({}),
      else: () => ({}),
    });

    step("control_only_switch").switch({
      cases: [{ when: true, then: () => ({}) }],
      default: () => ({}),
    });

    const branch = step("branch").if({
      condition: true,
      then: () => ({ status: "then" }),
      else: () => ({ status: "else" }),
    });
    expectTypeOf(branch.output.status).toEqualTypeOf<Expr<string>>();

    // @ts-expect-error if nodes always declare else.
    step("missing_if_else").if({
      condition: true,
      then: () => ({ status: "then" }),
    });

    // @ts-expect-error switch nodes always declare default.
    step("missing_switch_default").switch({
      cases: [{ when: true, then: () => ({ status: "case" }) }],
    });

    return { status: branch.output.status };
  });
});

test("nested objects and arrays are inferred from task and fanout callbacks", () => {
  defineWorkflow({ name: "typed-nested-output" }).build(({ step }) => {
    const task = step("task").task({
      run: {
        input: {},
        exec: async () => ({
          nested: { title: "ok" },
          items: [{ title: "ok" }],
        }),
      },
    });

    expectTypeOf(task.output.nested.title).toEqualTypeOf<Expr<string>>();
    expectTypeOf(head(task.output.items).title).toEqualTypeOf<Expr<string | undefined>>();

    const fanout = step("items").fanout({
      over: ["a"],
      do: ({ item }) => ({
        nested: { title: item },
        items: [{ title: item }],
      }),
    });

    assertType<Expr<string | undefined>>(head(fanout.output).nested.title);
    return { count: fanout.output };
  });
});

test("parallel all output is keyed by branch", () => {
  defineWorkflow({ name: "typed-parallel-output" }).build(({ step }) => {
    const parallel = step("parallel").parallel({
      branches: {
        left: {
          do: ({ step }) => {
            expectTypeOf(step).not.toBeAny();
            return { summary: "ok" };
          },
        },
        right: {
          do: () => ({ count: 1 }),
        },
      },
    });

    expectTypeOf(parallel.output.left.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(parallel.output.right.count).toEqualTypeOf<Expr<number>>();

    return {
      summary: parallel.output.left.summary,
      count: parallel.output.right.count,
    };
  });
});

test("nested composite callback contexts are not any", () => {
  defineWorkflow({ name: "typed-nested-composite-contexts" }).build(({ step }) => {
    step("parallel").parallel({
      branches: {
        branch: {
          do: ({ step }) => {
            expectTypeOf(step).not.toBeAny();

            step("loop").loop({
              initial: { done: false, summary: "seed" },
              maxIterations: 2,
              do: ({ iter, previous, step }) => {
                expectTypeOf(iter).not.toBeAny();
                expectTypeOf(previous).not.toBeAny();
                expectTypeOf(step).not.toBeAny();
                expectTypeOf(previous.summary).toEqualTypeOf<Expr<string>>();
                return { done: false, summary: previous.summary };
              },
              stopWhen: ({ result }) => {
                expectTypeOf(result).not.toBeAny();
                expectTypeOf(result.done).toEqualTypeOf<Expr<boolean>>();
                return result.done;
              },
            });

            step("switch").switch({
              cases: [
                {
                  when: true,
                  then: ({ step }) => {
                    expectTypeOf(step).not.toBeAny();
                    return { route: "auto" };
                  },
                },
              ],
              default: ({ step }) => {
                expectTypeOf(step).not.toBeAny();
                return { route: "manual" };
              },
            });

            const route = step("typed_switch").switch({
              cases: [{ when: true, then: () => ({ route: "auto" }) }],
              default: () => ({ route: "manual" }),
            });
            expectTypeOf(route.output.route).toEqualTypeOf<Expr<string>>();

            return {};
          },
        },
      },
    });

    return {};
  });
});

test("parallel race exposes a winner envelope", () => {
  defineWorkflow({ name: "typed-parallel-race-output" }).build(({ step }) => {
    const race = step("parallel_race").parallel({
      strategy: "race",
      branches: {
        fast: {
          do: () => ({ summary: "fast" }),
        },
        slow: {
          do: () => ({ summary: "slow" }),
        },
      },
    });

    expectTypeOf(race.output.winner).toEqualTypeOf<Expr<"fast" | "slow">>();
    expectTypeOf(race.output.result.summary).toEqualTypeOf<Expr<string>>();

    return {
      winner: race.output.winner,
      result: race.output.result,
    };
  });
});

test("fanout all and quorum output are arrays of accepted item outputs", () => {
  defineWorkflow({
    name: "typed-fanout-output",
    inputSchema: z.object({
      items: z.array(z.object({ id: z.string() })),
      title: z.string(),
    }),
  }).build(({ input, step }) => {
    const allItems = step("all_items").fanout({
      over: input.items,
      do: ({ item }) => {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return { id: item.id };
      },
    });

    assertType<Expr<Array<{ id: string }>>>(allItems.output);
    expectTypeOf(head(allItems.output).id).toEqualTypeOf<Expr<string | undefined>>();
    expectTypeOf(get(allItems.output, 1).id).toEqualTypeOf<Expr<string | undefined>>();

    const quorum = step("quorum_items").fanout({
      strategy: "quorum",
      count: 2,
      over: input.items,
      do: ({ item }) => ({ id: item.id }),
    });

    expectTypeOf(head(quorum.output).id).toEqualTypeOf<Expr<string | undefined>>();
    // @ts-expect-error quorum output is the accepted item array, not an envelope.
    quorum.output.accepted;

    step("bad_string_over").fanout({
      // @ts-expect-error fanout over must be an array, not a string.
      over: input.title,
      do: ({ item }) => ({ id: item }),
    });

    return { all: allItems.output, quorum: quorum.output };
  });
});

test("task outputs may be primitive, array, object, union, or undefined", () => {
  defineWorkflow({ name: "typed-task-leaf-outputs" }).build(({ step }) => {
    const primitive = step("primitive").task({
      run: { input: {}, exec: async () => "ok" },
    });
    expectTypeOf(primitive.output).toEqualTypeOf<Expr<string>>();

    const array = step("array").task({
      run: { input: {}, exec: async () => [{ id: "a" }] },
    });
    expectTypeOf(head(array.output).id).toEqualTypeOf<Expr<string | undefined>>();

    const maybe = step("maybe").task({
      run: { input: {}, exec: async (): Promise<{ ok: true } | undefined> => undefined },
    });
    expectTypeOf(maybe.output.ok).toEqualTypeOf<Expr<true | undefined>>();

    return { primitive: primitive.output, array: array.output, maybe: maybe.output };
  });
});

test("scope callback outputs are named objects", () => {
  defineWorkflow({ name: "typed-scope-object-output" }).build(({ step }) => {
    step("bad_fanout_item").fanout({
      over: ["a"],
      // @ts-expect-error fanout callbacks return named output objects.
      do: () => "bad",
    });

    step("bad_loop_body").loop({
      initial: { value: "seed" },
      maxIterations: 1,
      // @ts-expect-error loop body returns named output object matching initial.
      do: () => "bad",
      stopWhen: () => false,
      onExhausted: "returnLast",
    });

    assertType<OutputValues<{ value: string }>>({ value: "ok" });
    return {};
  });
});
