import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  z,
  type InferSchema,
  type OutputValues,
} from "../src/index.js";
import { fallback, get, head, type Expr } from "@acpus/expression";

const LoopOut = z.object({
  done: z.boolean(),
  summary: z.string(),
});

const OptionalOut = z.object({
  summary: z.string().optional(),
});

const NestedOut = z.object({
  nested: z.object({ title: z.string() }),
  items: z.array(z.object({ title: z.string() })),
});

const ParallelOut = z.object({
  left: z.object({ summary: z.string() }),
  right: z.object({ count: z.number() }),
});

test("loop previous output is optional and required outputs need fallback", () => {
  defineWorkflow({ name: "typed-loop-output" }).build(({ step }) => {
    const loop = step("loop").loop({
      maxIterations: 2,
      outputSchema: LoopOut,
      do: ({ previous }) => {
        expectTypeOf(previous.summary).toEqualTypeOf<Expr<string | undefined>>();
        expectTypeOf(fallback(previous.summary, "(none)")).toEqualTypeOf<Expr<string>>();
        return {
          done: false,
          summary: fallback(previous.summary, "(none)"),
        };
      },
      stopWhen: ({ result }) => result.done,
    });

    // Excess output fields are rejected at IR build time (diagnostic O001), not
    // by the type system: TypeScript does not apply excess-property checks to a
    // callback's return value. See validator.contract.test.ts for that contract.

    step("missing_required").loop({
      maxIterations: 2,
      outputSchema: LoopOut,
      // @ts-expect-error required output fields must be present in the returned object.
      do: () => ({ done: false }),
      stopWhen: ({ result }) => result.done,
    });

    step("nullable_required").loop({
      maxIterations: 2,
      outputSchema: LoopOut,
      // @ts-expect-error nullable previous output cannot satisfy a required string output.
      do: ({ previous }) => ({ done: false, summary: previous.summary }),
      stopWhen: ({ result }) => result.done,
    });

    return { done: loop.output.done };
  });
});

test("optional output fields may be omitted or receive optional refs", () => {
  defineWorkflow({ name: "typed-optional-output" }).build(({ step }) => {
    const loop = step("loop").loop({
      maxIterations: 2,
      outputSchema: OptionalOut,
      do: ({ previous }) => {
        assertType<OutputValues<InferSchema<typeof OptionalOut>>>({});
        return { summary: previous.summary };
      },
      stopWhen: () => false,
    });

    expectTypeOf(loop.output.summary).toEqualTypeOf<Expr<string | undefined>>();
    return { summary: loop.output.summary };
  });
});

test("nested objects and arrays are checked against output schema", () => {
  defineWorkflow({ name: "typed-nested-output" }).build(({ step }) => {
    const fanout = step("items").fanout({
      over: ["a"],
      itemOutputSchema: NestedOut,
      do: () => ({
        nested: { title: "ok" },
        items: [{ title: "ok" }],
      }),
    });

    step("bad_nested_field").fanout({
      over: ["a"],
      itemOutputSchema: NestedOut,
      // @ts-expect-error nested field type must match schema.
      do: () => ({ nested: { title: 1 }, items: [] }),
    });

    step("bad_array_item_field").fanout({
      over: ["a"],
      itemOutputSchema: NestedOut,
      // @ts-expect-error array item field type must match schema.
      do: () => ({ nested: { title: "ok" }, items: [{ title: 1 }] }),
    });

    return { count: fanout.output };
  });
});

test("parallel branch outputs are checked by branch key", () => {
  defineWorkflow({ name: "typed-parallel-output" }).build(({ step }) => {
    const parallel = step("parallel").parallel({
      branches: {
        left: {
          outputSchema: ParallelOut.shape.left,
          do: () => ({ summary: "ok" }),
        },
        right: {
          outputSchema: ParallelOut.shape.right,
          do: () => ({ count: 1 }),
        },
      },
    });

    step("bad_left_branch").parallel({
      branches: {
        left: {
          outputSchema: ParallelOut.shape.left,
          // @ts-expect-error left branch must return the left branch schema.
          do: () => ({ count: 1 }),
        },
      },
    });

    step("bad_right_branch").parallel({
      branches: {
        right: {
          outputSchema: ParallelOut.shape.right,
          // @ts-expect-error right branch must return the right branch schema.
          do: () => ({ summary: "wrong" }),
        },
      },
    });

    return {
      summary: parallel.output.left.summary,
      count: parallel.output.right.count,
    };
  });
});

test("parallel race exposes a winner envelope", () => {
  defineWorkflow({ name: "typed-parallel-race-output" }).build(({ step }) => {
    const race = step("parallel_race").parallel({
      strategy: "race",
      branches: {
        fast: {
          outputSchema: z.object({ summary: z.string() }),
          do: () => ({ summary: "fast" }),
        },
        slow: {
          outputSchema: z.object({ count: z.number() }),
          do: () => ({ count: 1 }),
        },
      },
    });

    expectTypeOf(race.output.winner).toEqualTypeOf<Expr<"fast" | "slow">>();
    assertType<Expr<{ summary: string } | { count: number }>>(race.output.result);

    return {
      winner: race.output.winner,
      result: race.output.result,
    };
  });
});

test("if and switch nodes with output schema require else and default", () => {
  const Status = z.object({ status: z.string() });

  defineWorkflow({ name: "typed-composite-output-paths" }).build(({ step }) => {
    step("control_only_if").if({
      condition: true,
      then: () => ({}),
    });

    step("control_only_switch").switch({
      cases: [{ when: true, then: () => ({}) }],
    });

    // @ts-expect-error if nodes with output schema must define else output.
    step("missing_if_else").if({
      condition: true,
      outputSchema: Status,
      then: () => ({ status: "then" }),
    });

    // @ts-expect-error switch nodes with output schema must define default output.
    step("missing_switch_default").switch({
      outputSchema: Status,
      cases: [{ when: true, then: () => ({ status: "case" }) }],
    });

    return {};
  });
});

test("fanout over must be a typed array and strategy controls final output", () => {
  defineWorkflow({
    name: "typed-fanout-output",
    inputSchema: z.object({
      items: z.array(z.object({ id: z.string() })),
      title: z.string(),
      payload: z.unknown(),
    }),
  }).build(({ input, step }) => {
    const allItems = step("all_items").fanout({
      over: input.items,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item }) => {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return { id: item.id };
      },
    });

    assertType<Expr<Array<{ id: string }>>>(allItems.output);
    expectTypeOf(head(allItems.output).id).toEqualTypeOf<Expr<string | undefined>>();
    expectTypeOf(get(allItems.output, 1).id).toEqualTypeOf<Expr<string | undefined>>();

    const literalItems = step("literal_items").fanout({
      over: [{ id: input.items[0]!.id }],
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item }) => {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return { id: item.id };
      },
    });

    expectTypeOf(head(literalItems.output).id).toEqualTypeOf<Expr<string | undefined>>();

    const quorum = step("quorum_items").fanout({
      strategy: "quorum",
      count: 2,
      over: input.items,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item }) => ({ id: item.id }),
    });

    expectTypeOf(head(quorum.output.accepted).id).toEqualTypeOf<Expr<string | undefined>>();
    expectTypeOf(head(quorum.output.completed).id).toEqualTypeOf<Expr<string | undefined>>();

    step("bad_string_over").fanout({
      // @ts-expect-error fanout over must be an array, not a string.
      over: input.title,
      itemOutputSchema: z.object({ id: z.string() }),
      do: () => ({ id: "bad" }),
    });

    step("bad_unknown_over").fanout({
      // @ts-expect-error fanout over must be explicitly typed as an array.
      over: input.payload,
      itemOutputSchema: z.object({ id: z.string() }),
      do: () => ({ id: "bad" }),
    });

    return {
      first: fallback(head(allItems.output).id, ""),
      accepted: quorum.output.accepted,
    };
  });
});

test("composite scope output schemas must be objects", () => {
  defineWorkflow({ name: "typed-object-composite-output" }).build(({ step }) => {
    step("bad_parallel_primitive").parallel({
      branches: {
        value: {
          // @ts-expect-error composite branch output schema must be an object.
          outputSchema: z.string(),
          do: () => ({ value: "bad" }),
        },
      },
    });

    step("bad_fanout_primitive").fanout({
      over: ["a"],
      // @ts-expect-error fanout per-item output schema must be an object.
      itemOutputSchema: z.string(),
      do: () => ({ value: "bad" }),
    });

    step("bad_if_primitive").if({
      condition: true,
      // @ts-expect-error if output schema must be an object.
      outputSchema: z.string(),
      then: () => ({ value: "bad" }),
      else: () => ({ value: "bad" }),
    });

    step("bad_switch_primitive").switch({
      // @ts-expect-error switch output schema must be an object.
      outputSchema: z.string(),
      cases: [{ when: true, then: () => ({ value: "bad" }) }],
      default: () => ({ value: "bad" }),
    });

    step("bad_loop_primitive").loop({
      maxIterations: 1,
      // @ts-expect-error loop output schema must be an object.
      outputSchema: z.string(),
      do: () => ({ value: "bad" }),
      stopWhen: () => true,
    });

    return {};
  });
});
