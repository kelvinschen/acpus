import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  z,
} from "../src/index.js";
import { fallback, head, nth, type Expr } from "../src/expression.js";

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
  defineWorkflow({ name: "typed-loop-output" }).build(({ step, output }) => {
    const loop = step("loop").loop({
      maxIterations: 2,
      outputSchema: LoopOut,
      do: ({ previous, output }) => {
        expectTypeOf(previous.summary).toEqualTypeOf<Expr<string | undefined>>();
        expectTypeOf(fallback(previous.summary, "(none)")).toEqualTypeOf<Expr<string>>();

        // @ts-expect-error nullable previous output cannot satisfy required string output.
        output({ done: false, summary: previous.summary });

        // @ts-expect-error required output fields must be present.
        output({ done: false });

        // @ts-expect-error output object literals cannot include fields outside the schema.
        output({ done: false, summary: "ok", extra: "nope" });

        return output({
          done: false,
          summary: fallback(previous.summary, "(none)"),
        });
      },
      stopWhen: ({ result }) => result.done,
    });

    return output({ done: loop.output.done });
  });
});

test("optional output fields may be omitted or receive optional refs", () => {
  defineWorkflow({ name: "typed-optional-output" }).build(({ step, output }) => {
    const loop = step("loop").loop({
      maxIterations: 2,
      outputSchema: OptionalOut,
      do: ({ previous, output }) => {
        assertType(output({}));
        return output({ summary: previous.summary });
      },
      stopWhen: () => false,
    });

    expectTypeOf(loop.output.summary).toEqualTypeOf<Expr<string | undefined>>();
    return output({ summary: loop.output.summary });
  });
});

test("nested objects and arrays are checked against output schema", () => {
  defineWorkflow({ name: "typed-nested-output" }).build(({ step, output }) => {
    const fanout = step("items").fanout({
      over: ["a"],
      itemOutputSchema: NestedOut,
      do: ({ output }) => {
        // @ts-expect-error nested field type must match schema.
        output({ nested: { title: 1 }, items: [] });

        // @ts-expect-error array item field type must match schema.
        output({ nested: { title: "ok" }, items: [{ title: 1 }] });

        return output({
          nested: { title: "ok" },
          items: [{ title: "ok" }],
        });
      },
    });

    return output({ count: fanout.output });
  });
});

test("parallel branch outputs are checked by branch key", () => {
  defineWorkflow({ name: "typed-parallel-output" }).build(({ step, output }) => {
    const parallel = step("parallel").parallel({
      branches: {
        left: {
          outputSchema: ParallelOut.shape.left,
          do: ({ output }) => {
            // @ts-expect-error left branch must return the left branch schema.
            output({ count: 1 });
            return output({ summary: "ok" });
          },
        },
        right: {
          outputSchema: ParallelOut.shape.right,
          do: ({ output }) => {
            // @ts-expect-error right branch must return the right branch schema.
            output({ summary: "wrong" });
            return output({ count: 1 });
          },
        },
      },
    });

    return output({
      summary: parallel.output.left.summary,
      count: parallel.output.right.count,
    });
  });
});

test("parallel race exposes a winner envelope", () => {
  defineWorkflow({ name: "typed-parallel-race-output" }).build(({ step, output }) => {
    const race = step("parallel_race").parallel({
      strategy: "race",
      branches: {
        fast: {
          outputSchema: z.object({ summary: z.string() }),
          do: ({ output }) => output({ summary: "fast" }),
        },
        slow: {
          outputSchema: z.object({ count: z.number() }),
          do: ({ output }) => output({ count: 1 }),
        },
      },
    });

    expectTypeOf(race.output.winner).toEqualTypeOf<Expr<"fast" | "slow">>();
    assertType<Expr<{ summary: string } | { count: number }>>(race.output.result);

    return output({
      winner: race.output.winner,
      result: race.output.result,
    });
  });
});

test("composite output schemas require current scope output on every path", () => {
  const Status = z.object({ status: z.string() });

  defineWorkflow({ name: "typed-composite-output-paths" }).build(({ step, output }) => {
    step("control_only_if").if({
      condition: true,
      then: ({ output }) => output({}),
    });

    step("control_only_switch").switch({
      cases: [{ when: true, then: ({ output }) => output({}) }],
    });

    // @ts-expect-error if nodes with output schema must define else output.
    step("missing_if_else").if({
      condition: true,
      outputSchema: Status,
      then: ({ output }) => output({ status: "then" }),
    });

    // @ts-expect-error switch nodes with output schema must define default output.
    step("missing_switch_default").switch({
      outputSchema: Status,
      cases: [{ when: true, then: ({ output }) => output({ status: "case" }) }],
    });

    step("captures_outer_output").if({
      condition: true,
      outputSchema: Status,
      // @ts-expect-error composite callback must return the current scope output token.
      then: () => output({ status: "outer" }),
      else: ({ output }) => output({ status: "inner" }),
    });

    step("captures_outer_composite_output").if({
      condition: true,
      outputSchema: Status,
      then: ({ output: outerOutput, step }) => {
        step("inner_same_schema").if({
          condition: true,
          outputSchema: Status,
          // @ts-expect-error nested composite callback must return its own scope output token.
          then: () => outerOutput({ status: "outer-composite" }),
          else: ({ output }) => output({ status: "inner-else" }),
        });
        return outerOutput({ status: "outer-then" });
      },
      else: ({ output }) => output({ status: "outer-else" }),
    });

    return output({});
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
  }).build(({ input, step, output }) => {
    const allItems = step("all_items").fanout({
      over: input.items,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item, output }) => {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return output({ id: item.id });
      },
    });

    assertType<Expr<Array<{ id: string }>>>(allItems.output);
    expectTypeOf(head(allItems.output).id).toEqualTypeOf<Expr<string | undefined>>();
    expectTypeOf(nth(allItems.output, 1).id).toEqualTypeOf<Expr<string | undefined>>();

    const literalItems = step("literal_items").fanout({
      over: [{ id: input.items[0]!.id }],
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item, output }) => {
        expectTypeOf(item.id).toEqualTypeOf<Expr<string>>();
        return output({ id: item.id });
      },
    });

    expectTypeOf(head(literalItems.output).id).toEqualTypeOf<Expr<string | undefined>>();

    const quorum = step("quorum_items").fanout({
      strategy: "quorum",
      count: 2,
      over: input.items,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ item, output }) => output({ id: item.id }),
    });

    expectTypeOf(head(quorum.output.accepted).id).toEqualTypeOf<Expr<string | undefined>>();
    expectTypeOf(head(quorum.output.completed).id).toEqualTypeOf<Expr<string | undefined>>();

    step("bad_string_over").fanout({
      // @ts-expect-error fanout over must be an array, not a string.
      over: input.title,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ output }) => output({ id: "bad" }),
    });

    step("bad_unknown_over").fanout({
      // @ts-expect-error fanout over must be explicitly typed as an array.
      over: input.payload,
      itemOutputSchema: z.object({ id: z.string() }),
      do: ({ output }) => output({ id: "bad" }),
    });

    return output({
      first: fallback(head(allItems.output).id, ""),
      accepted: quorum.output.accepted,
    });
  });
});

test("composite scope output schemas must be objects", () => {
  defineWorkflow({ name: "typed-object-composite-output" }).build(({ step, output }) => {
    step("bad_parallel_primitive").parallel({
      branches: {
        value: {
          // @ts-expect-error composite branch output schema must be an object.
          outputSchema: z.string(),
          do: ({ output }) => output({ value: "bad" }),
        },
      },
    });

    step("bad_fanout_primitive").fanout({
      over: ["a"],
      // @ts-expect-error fanout per-item output schema must be an object.
      itemOutputSchema: z.string(),
      do: ({ output }) => output({ value: "bad" }),
    });

    step("bad_if_primitive").if({
      condition: true,
      // @ts-expect-error if output schema must be an object.
      outputSchema: z.string(),
      then: ({ output }) => output({ value: "bad" }),
      else: ({ output }) => output({ value: "bad" }),
    });

    step("bad_switch_primitive").switch({
      // @ts-expect-error switch output schema must be an object.
      outputSchema: z.string(),
      cases: [{ when: true, then: ({ output }) => output({ value: "bad" }) }],
      default: ({ output }) => output({ value: "bad" }),
    });

    step("bad_loop_primitive").loop({
      maxIterations: 1,
      // @ts-expect-error loop output schema must be an object.
      outputSchema: z.string(),
      do: ({ output }) => output({ value: "bad" }),
      stopWhen: () => true,
    });

    return output({});
  });
});
