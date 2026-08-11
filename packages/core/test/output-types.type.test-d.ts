import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, task, z, type ArtifactRef, type JsonValue, type TaskFunction } from "@acpus/core";
import { lift, template, type Expr } from "@acpus/expression";

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
    expectTypeOf(lift(loop.output.history, history => history[0]?.summary ?? null)).toEqualTypeOf<Expr<string | null>>();
    assertType<Expr<string>>(lift(loop.output.history, history => history.map(item => item.summary).join("\n")));

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
  type AliasedOutput = { title: string; computed: boolean };
  const base = { title: "ok" };
  const key = "computed" as const;
  const branchCallback = (): AliasedOutput => ({ ...base, [key]: true });
  const taskCallback = async (): Promise<AliasedOutput> => ({ ...base, [key]: true });

  defineWorkflow({ name: "typed-nested-output" }).build(({ step }) => {
    const nestedTask = step("task").task({
      input: null,
      exec: async () => ({
        nested: { title: "ok" },
        items: [{ title: "ok" }],
      }),
    });

    expectTypeOf(nestedTask.output.nested.title).toEqualTypeOf<Expr<string>>();
    expectTypeOf(lift(nestedTask.output.items, items => items[0]?.title ?? null)).toEqualTypeOf<Expr<string | null>>();

    const fanout = step("items").fanout({
      over: ["a"],
      do({ item }) { return {
        nested: { title: item },
        items: [{ title: item }],
      }; },
    });

    const parallel = step("parallel").parallel({ branches: { branchCallback } });
    const callbackTask = step("callback_task").task({ input: null, exec: taskCallback });
    expectTypeOf(parallel.output.branchCallback.computed).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(callbackTask.output.title).toEqualTypeOf<Expr<string>>();

    assertType<Expr<string | null>>(lift(fanout.output, items => items[0]?.nested.title ?? null));
    return {
      count: fanout.output,
      title: parallel.output.branchCallback.title,
      computed: callbackTask.output.computed,
    };
  });
});

test("parallel all output is keyed by branch", () => {
  defineWorkflow({
    name: "typed-parallel-output",
    agents: { worker: { command: "worker" } },
  }).build(({ agents, step }) => {
    const parallel = step("parallel").parallel({
      branches: {
        left() {
          expectTypeOf(step).not.toBeAny();
          return { summary: "ok" };
        },
        right() { return { count: 1 }; },
        agentBranch() {
          const review = step("review").agent({
            agent: agents.worker,
            prompt: "review",
            outputSchema: z.object({ summary: z.string() }),
          });
          return { summary: review.output.summary };
        },
        taskBranch() {
          const task = step("task").task({ input: null, exec: async () => ({ ok: true }) });
          return { ok: task.output.ok };
        },
      },
    });

    expectTypeOf(parallel.output.left.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(parallel.output.right.count).toEqualTypeOf<Expr<number>>();
    expectTypeOf(parallel.output.agentBranch.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(parallel.output.taskBranch.ok).toEqualTypeOf<Expr<boolean>>();

    return {
      summary: parallel.output.left.summary,
      count: parallel.output.right.count,
      review: parallel.output.agentBranch.summary,
      ok: parallel.output.taskBranch.ok,
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
    expectTypeOf(lift(allItems.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();
    expectTypeOf(lift(allItems.output, items => items[1]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();

    const quorum = step("quorum_items").fanout({
      strategy: "quorum",
      count: 2,
      over: input.items,
      do({ item }) { return { id: item.id }; },
    });

    expectTypeOf(lift(quorum.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();
    // @ts-expect-error quorum output is the accepted item array, not an envelope.
    quorum.output.accepted;

    step("bad_string_over").fanout({
      // @ts-expect-error fanout over must be an array, not a string.
      over: input.title,
      // @ts-expect-error the invalid source makes the fanout callback output impossible.
      do({ item }) { return { id: item }; },
    });

    return { all: allItems.output, quorum: quorum.output };
  });
});

test("task outputs may be primitive, array, object, union, or undefined", () => {
  defineWorkflow({ name: "typed-task-leaf-outputs" }).build(({ step }) => {
    const primitive = step("primitive").task({
      input: null, exec: async () => "ok",
    });
    expectTypeOf(primitive.output).toEqualTypeOf<Expr<string>>();

    const array = step("array").task({
      input: null, exec: async () => [{ id: "a" }],
    });
    expectTypeOf(lift(array.output, items => items[0]?.id ?? null)).toEqualTypeOf<Expr<string | null>>();

    const maybe = step("maybe").task({
      input: null, exec: async (): Promise<{ ok: true } | undefined> => undefined,
    });
    expectTypeOf(maybe.output.ok).toEqualTypeOf<Expr<true | undefined>>();

    return { primitive: primitive.output, array: array.output, maybe: maybe.output };
  });
});

test("workflow and task output types enforce durable data", () => {
  const artifactRef = {} as ArtifactRef;
  const jsonValue = {} as JsonValue;
  const opaque = "value" as unknown;
  const broadObject = new Date() as object;
  const escape = undefined as any;
  const broadTask = undefined as unknown as TaskFunction<string, any>;

  defineWorkflow({
    name: "typed-durable-outputs",
    agents: { worker: { command: "worker" } },
  }).build(({ agents, step }) => {
    step("valid_task").task({
      input: null,
      exec: async () => ({ artifactRef, jsonValue, optional: undefined }),
    });
    const escaped = step("escaped_task").task({
      input: null, exec: async () => escape,
    });
    // @ts-expect-error poisoned any output cannot cross a string seam.
    step("escaped_prompt").agent({ agent: agents.worker, prompt: escaped.output });
    step("escaped_condition").if({
      // @ts-expect-error poisoned any output cannot cross a boolean seam.
      condition: escaped.output,
      then: () => ({}),
      else: () => ({}),
    });
    const escapedExecutor = step("escaped_executor").task({ input: null, exec: escape });
    // @ts-expect-error an any executor cannot produce a consumable string output.
    step("escaped_executor_prompt").agent({ agent: agents.worker, prompt: escapedExecutor.output });

    step("escaped_branch").parallel({
      branches: {
        // @ts-expect-error inherited any cannot cross a composite output seam.
        only() { return escape; },
      },
    });

    step("nested_any_branch").parallel({
      branches: {
        // @ts-expect-error any cannot cross a nested composite output seam.
        only() { return { escaped: escape }; },
      },
    });

    step("any_loop_state").loop({
      // @ts-expect-error any cannot cross the loop state seam.
      state: { escaped: escape },
      do() { return { state: { escaped: "safe" }, stop: true }; },
    });

    step("any_loop_transition").loop({
      state: { ok: false },
      // @ts-expect-error any cannot cross the loop transition seam.
      do() { return escape; },
    });

    step("unknown_loop_transition").loop({
      state: { ok: false },
      // @ts-expect-error unknown cannot cross the loop transition seam.
      do() { return opaque; },
    });

    const broadResult = step("broad_task").task({ input: "broad", exec: broadTask });
    step("broad_condition").if({
      // @ts-expect-error broad Task any output cannot cross a boolean seam.
      condition: broadResult.output,
      then: () => ({}),
      else: () => ({}),
    });
    const broadBranch = (() => ({ value: "ok" })) as () => Record<string, unknown>;
    // @ts-expect-error unknown callback-variable outputs cannot cross a composite seam.
    step("broad_parallel").parallel({ branches: { broadBranch } });
    const explicitlyUnknown = (() => "ok") as () => unknown;
    // @ts-expect-error unknown callback outputs cannot cross a composite seam.
    step("unknown_parallel").parallel({ branches: { explicitlyUnknown } });

    step("invalid_unknown_task").task({
      input: null,
      // @ts-expect-error unknown is not a durable Task output.
      exec: async () => opaque,
    });
    step("invalid_date_task").task({
      input: null,
      // @ts-expect-error Date is not a durable Task output.
      exec: async () => new Date(),
    });
    step("invalid_broad_object_task").task({
      input: null,
      // @ts-expect-error broad object types do not prove a durable Task output shape.
      exec: async () => broadObject,
    });
    step("invalid_function_task").task({
      input: null,
      // @ts-expect-error functions are not durable Task outputs.
      exec: async () => () => true,
    });
    step("invalid_promise_task").task({
      input: null,
      // @ts-expect-error nested promises are not durable Task outputs.
      exec: async () => ({ pending: Promise.resolve("later") }),
    });
    step("invalid_map_task").task({
      input: null,
      // @ts-expect-error Map is not a durable Task output.
      exec: async () => new Map([["key", "value"]]),
    });
    step("invalid_set_task").task({
      input: null,
      // @ts-expect-error Set is not a durable Task output.
      exec: async () => new Set(["value"]),
    });
    step("invalid_symbol_task").task({
      input: null,
      // @ts-expect-error symbols are not durable Task outputs.
      exec: async () => Symbol("value"),
    });
    step("invalid_bigint_task").task({
      input: null,
      // @ts-expect-error bigint is not a durable Task output.
      exec: async () => 1n,
    });
    step("invalid_array_undefined_task").task({
      input: null,
      // @ts-expect-error undefined array entries are not durable.
      exec: async () => ["ok", undefined],
    });

    return { artifactRef, jsonValue };
  });

  const escapedReusable = task.define({
    inputSchema: z.null(),
    exec: async () => escape,
  });
  expectTypeOf<Awaited<ReturnType<typeof escapedReusable.fn>>>().toEqualTypeOf<never>();

  // @ts-expect-error root workflow output cannot contain any.
  defineWorkflow({ name: "invalid-root-any" }).build(() => ({ escaped: escape }));
  // @ts-expect-error root workflow output cannot contain unknown.
  defineWorkflow({ name: "invalid-root-output" }).build(() => ({ opaque }));
  // @ts-expect-error root workflow output cannot contain Date.
  defineWorkflow({ name: "invalid-root-date" }).build(() => ({ when: new Date() }));
  // @ts-expect-error broad object types do not prove a durable root output shape.
  defineWorkflow({ name: "invalid-root-broad-object" }).build(() => broadObject);
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
    expectTypeOf(lift(conditional.output, value => "left" in value ? value.left : false)).toEqualTypeOf<Expr<boolean>>();

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

test("scope callbacks return arbitrary workflow data while NodeRef stays a control handle", () => {
  defineWorkflow({ name: "typed-scope-workflow-data-output" }).build(({ step }) => {
    const leaf = step("leaf").task({ input: null, exec: async () => ({ value: "ok" }) });

    step("bad_direct_ref").parallel({
      branches: {
        // @ts-expect-error NodeRef is a control handle, not a composite output.
        only() { return leaf; },
      },
    });

    step("bad_nested_ref").parallel({
      branches: {
        // @ts-expect-error NodeRef cannot be nested inside a durable output.
        only() { return { leaf }; },
      },
    });

    const directExpr = step("direct_expr").parallel({
      branches: {
        only() { return leaf.output.value; },
      },
    });
    expectTypeOf(directExpr.output.only).toEqualTypeOf<Expr<string>>();

    const scalarSource: string[] = ["a"];
    const scalarItems = step("scalar_items").fanout({
      over: scalarSource,
      do({ item }) { return item; },
    });
    expectTypeOf(lift(scalarItems.output, items => items[0] ?? null)).toEqualTypeOf<Expr<string | null>>();

    const scalarBranch = step("scalar_branch").if({
      condition: true,
      then() { return "ready"; },
      else() { return 0; },
    });
    expectTypeOf(scalarBranch.output).toEqualTypeOf<Expr<string | number>>();

    const widenedBranch = step("widened_branch").if({
      condition: true,
      then() { return "ready"; },
      else() { return "blocked"; },
    });
    expectTypeOf(widenedBranch.output).toEqualTypeOf<Expr<string>>();

    const narrowBranch = step("narrow_branch").if({
      condition: true,
      then() { return "ready" as const; },
      else() { return "blocked" as const; },
    });
    expectTypeOf(narrowBranch.output).toEqualTypeOf<Expr<"ready" | "blocked">>();

    const scalarParallel = step("scalar_parallel").parallel({
      branches: {
        count() { return 1; },
        empty() { return null; },
      },
    });
    expectTypeOf(scalarParallel.output.count).toEqualTypeOf<Expr<number>>();
    expectTypeOf(scalarParallel.output.empty).toEqualTypeOf<Expr<null>>();

    const scalarLoop = step("scalar_loop").loop({
      state: 0,
      do({ state }) {
        expectTypeOf(state).toEqualTypeOf<Expr<number>>();
        return { state, stop: true };
      },
    });
    expectTypeOf(scalarLoop.output).toEqualTypeOf<Expr<number>>();

    type Phase = "pending" | "done";
    const literalLoop = step("literal_loop").loop({
      state: "pending" as Phase,
      do({ state }) { return { state, stop: true }; },
    });
    expectTypeOf(literalLoop.output).toEqualTypeOf<Expr<Phase>>();

    const constLiteralLoop = step("const_literal_loop").loop({
      state: "pending" as const,
      do({ state }) { return { state, stop: true }; },
    });
    expectTypeOf(constLiteralLoop.output).toEqualTypeOf<Expr<"pending">>();

    const nullLoop = step("null_loop").loop({
      state: null,
      do({ state }) { return { state, stop: true }; },
    });
    expectTypeOf(nullLoop.output).toEqualTypeOf<Expr<null>>();

    const arrayLoop = step("array_loop").loop({
      state: [] as string[],
      do({ state }) { return { state, stop: true }; },
    });
    assertType<Expr<string[]>>(arrayLoop.output);

    step("bad_loop_body").loop({
      state: { value: "seed" },
      // @ts-expect-error loop body returns a transition object.
      do() { return "bad"; },
    });

    return leaf.output.value;
  });

  defineWorkflow({ name: "direct-root-scalar" }).build(() => "ok");
  defineWorkflow({ name: "direct-root-null" }).build(() => null);
  defineWorkflow({ name: "direct-root-array" }).build(() => ["ok", 1, null]);
  // @ts-expect-error workflow callbacks cannot return NodeRef control handles.
  defineWorkflow({ name: "bad-direct-root-ref" }).build(({ step }) =>
    step("leaf").task({ input: null, exec: async () => ({ value: "ok" }) }));
  // @ts-expect-error scope callbacks are synchronous and promises are not durable values.
  defineWorkflow({ name: "bad-root-promise" }).build(async () => "later");
});

test("optional expressions are allowed only as object fields", () => {
  const optional = null as unknown as Expr<string | undefined>;

  defineWorkflow({ name: "optional-object-field" }).build(() => ({ optional }));
  defineWorkflow({ name: "optional-composite-field" }).build(({ step }) => {
    const branch = step("branch").parallel({ branches: { only() { return { optional }; } } });
    expectTypeOf(branch.output.only.optional).toEqualTypeOf<Expr<string | undefined>>();
    return {};
  });

  // @ts-expect-error a scope must always produce a top-level workflow value.
  defineWorkflow({ name: "optional-root" }).build(() => optional);
  // @ts-expect-error array elements cannot resolve to undefined.
  defineWorkflow({ name: "optional-array-item" }).build(() => [optional]);
});
