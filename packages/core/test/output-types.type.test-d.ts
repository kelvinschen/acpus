import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, z, type ArtifactRef, type JsonValue, type OutputValues } from "../src/index.js";
import { fmap, template, type Expr } from "@acpus/expression";

test("loop state defines non-optional carried state and output shape", () => {
  defineWorkflow({ name: "typed-loop-output" }).build(({ step }) => {
    type RoundResult = { round: number; summary: string };
    const emptyHistory: RoundResult[] = [];
    const loop = step("loop").loop({
      state: { done: false as boolean, summary: "seed", history: emptyHistory },
      do({ state, index, round }) {
        expectTypeOf(state.summary).toEqualTypeOf<Expr<string>>();
        expectTypeOf(index).toEqualTypeOf<Expr<number>>();
        expectTypeOf(round).toEqualTypeOf<Expr<number>>();
        return {
          state: {
            done: false,
            summary: template`Round ${round}: ${state.summary}`,
            history: state.history,
          },
          stop: false,
        };
      },
    });

    expectTypeOf(loop.output.done).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(loop.output.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(fmap(loop.output.history, history => history[0]?.summary ?? null)).toEqualTypeOf<Expr<string | null>>();
    assertType<Expr<string>>(fmap(loop.output.history, history => history.map(item => item.summary).join("\n")));

    type Phase = "pending" | "done";
    const state = step("state").loop({
      state: { done: false, phase: "pending" as Phase },
      do({ state }) { return {
        state: {
          done: false,
          phase: state.phase,
        },
        stop: false,
      }; },
    });
    expectTypeOf(state.output.done).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(state.output.phase).toEqualTypeOf<Expr<Phase>>();

    const counted = step("counted").loop({
      state: { ok: false as boolean },
      do() { return { state: { ok: true }, stop: true }; },
    });
    expectTypeOf(counted.output.ok).toEqualTypeOf<Expr<boolean>>();

    step("missing_required").loop({
      state: { done: false, summary: "seed" },
      // @ts-expect-error loop do result must converge with initial shape.
      do() { return { state: { done: false }, stop: true }; },
    });

    step("missing_transition_state").loop({
      state: { done: false },
      // @ts-expect-error loop transition must include state.
      do() { return { stop: true }; },
    });

    step("missing_transition_stop").loop({
      state: { done: false },
      // @ts-expect-error loop transition must include stop.
      do() { return { state: { done: true } }; },
    });

    step("bad_transition_stop").loop({
      state: { done: false },
      // @ts-expect-error loop transition stop must be boolean-like.
      do() { return { state: { done: true }, stop: "yes" }; },
    });

    step("extra_transition_key").loop({
      state: { done: false },
      // @ts-expect-error loop transition must contain exactly state and stop.
      do() { return { state: { done: true }, stop: true, debug: 1 }; },
    });

    return { done: loop.output.done, summary: loop.output.summary };
  });
});

test("control-only and output-producing if/switch require fallbacks", () => {
  defineWorkflow({ name: "typed-composite-output-paths" }).build(({ step }) => {
    step("control_only_if").if({
      condition: true,
      then() { return {}; },
      else() { return {}; },
    });

    step("control_only_switch").switch({
      cases: [{ when: true, then() { return {}; } }],
      default() { return {}; },
    });

    const branch = step("branch").if({
      condition: true,
      then() { return { status: "then" }; },
      else() { return { status: "else" }; },
    });
    expectTypeOf(branch.output.status).toEqualTypeOf<Expr<string>>();

    // @ts-expect-error if nodes always declare else.
    step("missing_if_else").if({
      condition: true,
      then() { return { status: "then" }; },
    });

    // @ts-expect-error switch nodes always declare default.
    step("missing_switch_default").switch({
      cases: [{ when: true, then() { return { status: "case" }; } }],
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
    expectTypeOf(fmap(task.output.items, items => items[0]?.title ?? null)).toEqualTypeOf<Expr<string | null>>();

    const fanout = step("items").fanout({
      over: ["a"],
      do({ item }) { return {
        nested: { title: item },
        items: [{ title: item }],
      }; },
    });

    assertType<Expr<string | null>>(fmap(fanout.output, items => items[0]?.nested.title ?? null));
    return { count: fanout.output };
  });
});

test("parallel all output is keyed by branch", () => {
  defineWorkflow({ name: "typed-parallel-output" }).build(({ step }) => {
    const parallel = step("parallel").parallel({
      branches: {
        left() {
          expectTypeOf(step).not.toBeAny();
          return { summary: "ok" };
        },
        right() { return { count: 1 }; },
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
        branch() {
          expectTypeOf(step).not.toBeAny();

          step("loop").loop({
            state: { done: false, summary: "seed" },
            do({ index, round, state }) {
              expectTypeOf(index).not.toBeAny();
              expectTypeOf(round).not.toBeAny();
              expectTypeOf(state).not.toBeAny();
              expectTypeOf(step).not.toBeAny();
              expectTypeOf(state.summary).toEqualTypeOf<Expr<string>>();
              return {
                state: { done: false, summary: state.summary },
                stop: false,
              };
            },
          });

          step("switch").switch({
            cases: [
              {
                when: true,
                then() {
                  expectTypeOf(step).not.toBeAny();
                  return { route: "auto" };
                },
              },
            ],
            default() {
              expectTypeOf(step).not.toBeAny();
              return { route: "manual" };
            },
          });

          const route = step("typed_switch").switch({
            cases: [{ when: true, then() { return { route: "auto" }; } }],
            default() { return { route: "manual" }; },
          });
          expectTypeOf(route.output.route).toEqualTypeOf<Expr<string>>();

          return {};
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
        fast() { return { summary: "fast" }; },
        slow() { return { summary: "slow" }; },
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
      do({ item }) {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return { id: item.id };
      },
    });

    assertType<Expr<Array<{ id: string }>>>(allItems.output);
    expectTypeOf(fmap(allItems.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();
    expectTypeOf(fmap(allItems.output, items => items[1]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();

    const quorum = step("quorum_items").fanout({
      strategy: "quorum",
      count: 2,
      over: input.items,
      do({ item }) { return { id: item.id }; },
    });

    expectTypeOf(fmap(quorum.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();
    // @ts-expect-error quorum output is the accepted item array, not an envelope.
    quorum.output.accepted;

    // @ts-expect-error fanout over must be an array, not a string.
    step("bad_string_over").fanout({
      over: input.title,
      do({ item }) { return { id: item }; },
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
    expectTypeOf(fmap(array.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();

    const maybe = step("maybe").task({
      run: { input: {}, exec: async (): Promise<{ ok: true } | undefined> => undefined },
    });
    expectTypeOf(maybe.output.ok).toEqualTypeOf<Expr<true | undefined>>();

    return { primitive: primitive.output, array: array.output, maybe: maybe.output };
  });
});

test("workflow output types enforce durable data and preserve explicit escapes", () => {
  const artifactRef = {} as ArtifactRef;
  const jsonValue = {} as JsonValue;
  const opaque = "value" as unknown;
  const escape = undefined as any;

  defineWorkflow({ name: "typed-durable-outputs" }).build(({ step }) => {
    step("valid_task").task({
      run: {
        input: {},
        exec: async () => ({ artifactRef, jsonValue, optional: undefined }),
      },
    });
    step("escaped_task").task({
      run: { input: {}, exec: async () => escape },
    });
    step("invalid_unknown_task").task({
      run: {
        input: {},
        // @ts-expect-error unknown is not a durable Task output.
        exec: async () => opaque,
      },
    });
    step("invalid_date_task").task({
      run: {
        input: {},
        // @ts-expect-error Date is not a durable Task output.
        exec: async () => new Date(),
      },
    });
    step("invalid_function_task").task({
      run: {
        input: {},
        // @ts-expect-error functions are not durable Task outputs.
        exec: async () => () => true,
      },
    });
    step("invalid_promise_task").task({
      run: {
        input: {},
        // @ts-expect-error nested promises are not durable Task outputs.
        exec: async () => ({ pending: Promise.resolve("later") }),
      },
    });
    step("invalid_map_task").task({
      run: {
        input: {},
        // @ts-expect-error Map is not a durable Task output.
        exec: async () => new Map([["key", "value"]]),
      },
    });
    step("invalid_set_task").task({
      run: {
        input: {},
        // @ts-expect-error Set is not a durable Task output.
        exec: async () => new Set(["value"]),
      },
    });
    step("invalid_symbol_task").task({
      run: {
        input: {},
        // @ts-expect-error symbols are not durable Task outputs.
        exec: async () => Symbol("value"),
      },
    });
    step("invalid_bigint_task").task({
      run: {
        input: {},
        // @ts-expect-error bigint is not a durable Task output.
        exec: async () => 1n,
      },
    });
    step("invalid_array_undefined_task").task({
      run: {
        input: {},
        // @ts-expect-error undefined array entries are not durable.
        exec: async () => ["ok", undefined],
      },
    });

    return { artifactRef, jsonValue, escaped: escape };
  });

  // @ts-expect-error root workflow output cannot contain unknown.
  defineWorkflow({ name: "invalid-root-output" }).build(() => ({ opaque }));
  // @ts-expect-error root workflow output cannot contain Date.
  defineWorkflow({ name: "invalid-root-date" }).build(() => ({ when: new Date() }));
  // @ts-expect-error root workflow output cannot contain raw undefined.
  defineWorkflow({ name: "invalid-root-undefined" }).build(() => ({ optional: undefined }));
  // @ts-expect-error nested root workflow output cannot contain raw undefined.
  defineWorkflow({ name: "invalid-root-nested-undefined" }).build(() => ({ payload: { optional: undefined } }));
  defineWorkflow({ name: "invalid-composite-undefined" }).build(({ step }) => {
    // @ts-expect-error composite outputs cannot contain raw undefined.
    step("parallel").parallel({ branches: { only() { return { optional: undefined }; } } });
    return {};
  });
});

test("branch outputs infer unions while loop transitions remain exact", () => {
  defineWorkflow({ name: "typed-union-outputs" }).build(({ step }) => {
    const conditional = step("conditional").if({
      condition: true,
      then() { return { common: "then", left: true }; },
      else() { return { common: "else", right: 1 }; },
    });
    expectTypeOf(conditional.output.common).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error branch-specific fields are not safe on a union output.
    conditional.output.left;

    const switched = step("switched").switch({
      cases: [{ when: true, then() { return { common: "case", code: 1 }; } }],
      default() { return { common: "default", fallback: true }; },
    });
    expectTypeOf(switched.output.common).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error switch-specific fields are not safe on a union output.
    switched.output.code;

    const raced = step("raced").parallel({
      strategy: "race",
      branches: {
        left() { return { common: "left", left: true }; },
        right() { return { common: "right", right: 1 }; },
      },
    });
    expectTypeOf(raced.output.result.common).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error race-specific fields are not safe on the result union.
    raced.output.result.left;

    return { conditional: conditional.output, switched: switched.output, raced: raced.output };
  });

  defineWorkflow({ name: "root-union-output" }).build(() => {
    if (Date.now() > 0) return { left: true };
    return { right: true };
  });
});

test("scope callback outputs are named objects", () => {
  defineWorkflow({ name: "typed-scope-object-output" }).build(({ step }) => {
    step("bad_fanout_item").fanout({
      over: ["a"],
      // @ts-expect-error fanout callbacks return named output objects.
      do() { return "bad"; },
    });

    step("bad_loop_body").loop({
      state: { value: "seed" },
      // @ts-expect-error loop body returns a transition object.
      do() { return "bad"; },
    });

    assertType<OutputValues<{ value: string }>>({ value: "ok" });
    return {};
  });
});
