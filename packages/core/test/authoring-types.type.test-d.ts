import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  task,
  z,
  type AgentDefinitionSpec,
  type AgentMap,
  type AgentStepSpec,
  type AgentToken,
  type ArtifactRef,
  type JsonObject,
  type JsonValue,
  type ReusableTaskToken,
  type StepDeclaration,
} from "@acpus/core";
import { lift, md, template, type Expr } from "@acpus/expression";

declare const durableSymbolKey: unique symbol;

interface SymbolKeyInput {
  [durableSymbolKey]: string;
}

test("step declaration object exposes kind methods", () => {
  defineWorkflow({ name: "typed-step-declaration", description: "Type-level workflow metadata." }).build(({ input, step }) => {
    // @ts-expect-error workflows without inputSchema have no input fields.
    input.repoPath;
    const declaration = step("require_true");
    assertType<StepDeclaration>(declaration);
    assertType<void>(declaration.assert({ condition: true }));
    return {};
  });
});

test("root exports opaque JSON output types", () => {
  assertType<JsonValue>({ ok: true, items: [1, "two", null] });
  assertType<JsonObject>({ ok: true });
});

test("agent tokens are typed from top-level agent keys", () => {
  const extractedAgents = {
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  } satisfies AgentMap;

  assertType<AgentDefinitionSpec>({ use: "codex", permissionMode: "approve-reads", config: { mode: "agent" } });
  assertType<AgentDefinitionSpec>({ command: "acpx worker", model: "gpt-5.4", permissionMode: "approve-all", config: { model: "gpt-5.4", mode: "bypassPermissions" } });
  // @ts-expect-error agent definitions must use either use or command, not both.
  assertType<AgentDefinitionSpec>({ use: "codex", command: "acpx worker" });
  // @ts-expect-error agentMode was replaced by the config map.
  assertType<AgentDefinitionSpec>({ use: "codex", agentMode: "agent" });
  // @ts-expect-error agent config values are strings.
  assertType<AgentDefinitionSpec>({ use: "codex", config: { fast: true } });

  defineWorkflow({ name: "typed-agent-keys", agents: extractedAgents }).build(({ agents, step }) => {
    assertType<AgentToken<"reviewer">>(agents.reviewer);
    const raw = step("raw_agent").agent({
      agent: agents.reviewer, prompt: "ok",
    });
    expectTypeOf(raw.output).toEqualTypeOf<Expr<string>>();

    const structured = step("structured_agent").agent({
      outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
      agent: agents.reviewer, prompt: "ok",
    });
    expectTypeOf(structured.output.ok).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(structured.output.summary).toEqualTypeOf<Expr<string>>();

    // @ts-expect-error agent reference must come from a declared top-level agent key.
    agents.missing;
    return {};
  });
});

test("agent step specs require agent tokens", () => {
  const reviewer = null as unknown as AgentToken<"reviewer">;
  const declaration = {} as StepDeclaration;
  declaration.agent({ agent: reviewer, prompt: "ok" });

  const stepSpec: AgentStepSpec<undefined> = { agent: reviewer, prompt: "ok" };
  const badStepSpec: AgentStepSpec<undefined> = {
    // @ts-expect-error agent steps accept tokens, not string keys.
    agent: "reviewer",
    prompt: "bad",
  };
  void stepSpec;
  void badStepSpec;
});

test("schema-backed nodes preserve native Zod tuple output types", () => {
  const ChoiceSchema = z.object({ label: z.string() });
  const ChoicesSchema = z.tuple([ChoiceSchema, ChoiceSchema, ChoiceSchema]);
  type Choice = z.output<typeof ChoiceSchema>;
  type Choices = [Choice, Choice, Choice];

  defineWorkflow({ name: "typed-tuple-output", agents: { worker: { use: "codex" } } }).build(({ agents, step }) => {
    const choices = step("choices").agent({
      outputSchema: ChoicesSchema,
      agent: agents.worker,
      prompt: "Return three choices.",
    });
    assertType<Expr<Choices>>(choices.output);
    const thirdLabel = lift(choices.output, output => {
      expectTypeOf(output).toEqualTypeOf<Choices>();
      return output[2].label;
    });
    expectTypeOf(thirdLabel).toEqualTypeOf<Expr<string>>();
    return { thirdLabel };
  });
});

test("task outputs are inferred from inline and reusable exec", () => {
  // @ts-expect-error reusable task token references must spell out input and output when they are manually annotated.
  type BareReusableTaskToken = ReusableTaskToken;

  const PackageInput = z.object({ packageName: z.string(), version: z.string() });
  const reusablePackageTask = task.define({
    inputSchema: PackageInput,
    exec: async ({ input, abortSignal }) => {
      assertType<string>(input.version);
      assertType<AbortSignal>(abortSignal);
      return { packageName: input.packageName, version: input.version, ok: true };
    },
  });
  defineWorkflow({ name: "typed-task-output", inputSchema: PackageInput }).build(({ input, step }) => {
    const inline = step("inline").task({
      input: { packageName: input.packageName, version: input.version },
      exec: async ({ input }) => {
        assertType<string>(input.version);
        // @ts-expect-error runtime input is unwrapped as string, not number.
        assertType<number>(input.version);
        return { version: input.version, ok: true };
      },
    });
    expectTypeOf(inline.output.version).toEqualTypeOf<Expr<string>>();
    expectTypeOf(inline.output.ok).toEqualTypeOf<Expr<boolean>>();

    const reusable = step("reusable").task({
      input: { packageName: input.packageName, version: input.version },
      task: reusablePackageTask,
    });
    expectTypeOf(reusable.output.version).toEqualTypeOf<Expr<string>>();
    expectTypeOf(reusable.output.ok).toEqualTypeOf<Expr<boolean>>();

    step("ambiguous_target").task({
      input: { packageName: input.packageName, version: input.version },
      exec: async () => ({ ok: true }),
      // @ts-expect-error a Task step must choose exactly one execution target.
      task: reusablePackageTask,
    });

    return { ok: inline.output.ok, version: reusable.output.version };
  });
});

test("Task input accepts each durable authored value category and preserves its materialized type", () => {
  const StringTask = task.define({
    inputSchema: z.string(),
    exec: async ({ input }) => {
      expectTypeOf(input).toEqualTypeOf<string>();
      return input.length;
    },
  });
  const ArrayTask = task.define({
    inputSchema: z.array(z.string()),
    exec: async ({ input }) => {
      expectTypeOf(input).toEqualTypeOf<string[]>();
      return input.length;
    },
  });
  const TupleTask = task.define({
    inputSchema: z.tuple([z.string(), z.number()]),
    exec: async ({ input }) => {
      expectTypeOf(input).toEqualTypeOf<[string, number]>();
      return input[1];
    },
  });
  const ObjectTask = task.define({
    inputSchema: z.object({ title: z.string() }),
    exec: async ({ input }) => input.title,
  });
  const UnionTask = task.define({
    inputSchema: z.union([z.string(), z.number()]),
    exec: async ({ input }) => input,
  });
  const UnknownTask = task.define({
    inputSchema: z.unknown(),
    exec: async ({ input }) => input === null,
  });

  interface AuthoredInput {
    readonly title: Expr<string>;
    readonly note?: Expr<string>;
  }

  defineWorkflow({
    name: "durable-task-input",
    inputSchema: z.object({
      title: z.string(),
      items: z.array(z.string()),
      optional: z.string().optional(),
    }),
  }).build(({ input, step }) => {
    step("raw_number").task({
      input: 1,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<1>();
        return input;
      },
    });
    step("string").task({
      input: input.title,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<string>();
        return input.length;
      },
    });
    step("null").task({
      input: null,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<null>();
        return input;
      },
    });
    step("tuple").task({
      input: [input.title, 1] as const,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<[string, 1]>();
        return input;
      },
    });
    step("array_expr").task({
      input: input.items,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<string[]>();
        return input;
      },
    });
    const authored: AuthoredInput = { title: input.title };
    step("interface").task({
      input: authored,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ title: string; note?: string }>();
        return input.title;
      },
    });
    const artifact = {
      kind: "artifact",
      uri: "artifact://run/output",
    } as const satisfies ArtifactRef;
    step("artifact").task({
      input: artifact,
      exec: async ({ input }) => {
        assertType<ArtifactRef>(input);
        return input.uri;
      },
    });
    step("optional_object_field").task({
      input: { optional: input.optional },
      exec: async ({ input }) => input.optional ?? "missing",
    });
    const optionalObjectExpr = null as unknown as Expr<{ note?: string }>;
    step("optional_expr_object").task({
      input: optionalObjectExpr,
      exec: async ({ input }) => input.note ?? "missing",
    });
    const unionExpr = null as unknown as Expr<string | number>;
    step("union_expr").task({
      input: unionExpr,
      exec: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<string | number>();
        return input;
      },
    });

    step("reusable_string").task({ task: StringTask, input: input.title });
    step("reusable_array").task({ task: ArrayTask, input: input.items });
    step("reusable_tuple").task({ task: TupleTask, input: [input.title, 1] as const });
    step("reusable_object").task({ task: ObjectTask, input: { title: input.title, extra: true } });
    step("reusable_union").task({ task: UnionTask, input: input.title });
    step("reusable_unknown").task({ task: UnknownTask, input: [input.title] });

    const scalarMismatch = step("reusable_scalar_mismatch").task({
      task: StringTask,
      // @ts-expect-error reusable scalar input must match its schema witness.
      input: 1,
    });
    expectTypeOf(scalarMismatch.output).toEqualTypeOf<Expr<number>>();
    const tupleMismatch = step("reusable_tuple_mismatch").task({
      task: TupleTask,
      // @ts-expect-error tuple positions are checked independently.
      input: [input.title, "wrong"] as const,
    });
    expectTypeOf(tupleMismatch.output).toEqualTypeOf<Expr<number>>();
    const requiredMismatch = step("reusable_required_mismatch").task({
      task: ObjectTask,
      // @ts-expect-error reusable object input must contain required fields.
      input: {},
    });
    expectTypeOf(requiredMismatch.output).toEqualTypeOf<Expr<string>>();
    const missingExpressionMismatch = step("reusable_missing_expression_mismatch").task({
      task: ObjectTask,
      // @ts-expect-error an expression that may resolve missing cannot satisfy a required string.
      input: { title: input.optional },
    });
    expectTypeOf(missingExpressionMismatch.output).toEqualTypeOf<Expr<string>>();
    return {};
  });
});

test("Task input rejects values outside the durable authored boundary", () => {
  const unknownValue = undefined as unknown;
  const anyValue = undefined as any;
  const anyExpr = undefined as unknown as Expr<any>;
  const unknownExpr = undefined as unknown as Expr<unknown>;
  const nestedExpr = undefined as unknown as Expr<{ nested: Expr<string> }>;
  const nestedNodeRef =
    undefined as unknown as Expr<{ nested: ReturnType<StepDeclaration["agent"]> }>;
  const rawNodeRef = undefined as unknown as ReturnType<StepDeclaration["agent"]>;
  const symbolKeyInput = undefined as unknown as SymbolKeyInput;
  const broadObject = new Date() as object;
  const broadObjectExpr = undefined as unknown as Expr<object>;
  const promise = undefined as unknown as Promise<string>;
  const callback = undefined as unknown as () => string;
  const requiredUndefinedExpr =
    undefined as unknown as Expr<{ value: string | undefined }>;
  const requiredMaybe = undefined as string | undefined;

  defineWorkflow({
    name: "invalid-task-input",
    inputSchema: z.object({ optional: z.string().optional() }),
  }).build(({ input, step }) => {
    // @ts-expect-error Task input is required even when exec ignores it.
    step("missing_input").task({ exec: async () => null });
    // @ts-expect-error top-level raw undefined is not durable Task input.
    step("undefined").task({ input: undefined, exec: async ({ input }) => input });
    // @ts-expect-error a top-level expression that can resolve missing is not durable Task input.
    step("optional_expr").task({ input: input.optional, exec: async ({ input }) => input });
    // @ts-expect-error a required property inside an opaque expression cannot resolve undefined.
    step("required_undefined_expr").task({ input: requiredUndefinedExpr, exec: async ({ input }) => input });
    // @ts-expect-error arrays cannot contain raw undefined.
    step("array_undefined").task({ input: ["ok", undefined], exec: async ({ input }) => input });
    // @ts-expect-error arrays cannot contain expressions that may resolve missing.
    step("array_optional_expr").task({ input: [input.optional], exec: async ({ input }) => input });
    // @ts-expect-error required object fields cannot include raw undefined.
    step("object_undefined").task({ input: { value: undefined }, exec: async ({ input }) => input });
    // @ts-expect-error required object fields cannot include a raw undefined union.
    step("object_required_maybe").task({ input: { value: requiredMaybe }, exec: async ({ input }) => input });
    // @ts-expect-error any cannot escape the durable Task input check.
    step("any").task({ input: anyValue, exec: async ({ input }) => input });
    // @ts-expect-error nested any cannot escape the durable Task input check.
    step("nested_any").task({ input: { value: anyValue }, exec: async ({ input }) => input });
    // @ts-expect-error unknown must be narrowed before authoring Task input.
    step("unknown").task({ input: unknownValue, exec: async ({ input }) => input });
    // @ts-expect-error nested unknown must be narrowed before authoring Task input.
    step("nested_unknown").task({ input: { value: unknownValue }, exec: async ({ input }) => input });
    // @ts-expect-error an expression payload cannot be any.
    step("expr_any").task({ input: anyExpr, exec: async ({ input }) => input });
    // @ts-expect-error an expression payload cannot be unknown.
    step("expr_unknown").task({ input: unknownExpr, exec: async ({ input }) => input });
    // @ts-expect-error an evaluated expression cannot contain another expression token.
    step("nested_expr").task({ input: nestedExpr, exec: async ({ input }) => input });
    // @ts-expect-error an evaluated expression cannot contain a NodeRef control handle.
    step("nested_node_ref").task({ input: nestedNodeRef, exec: async ({ input }) => input });
    // @ts-expect-error a raw NodeRef is a control handle, not durable Task input.
    step("raw_node_ref").task({ input: rawNodeRef, exec: async ({ input }) => input });
    // @ts-expect-error durable objects cannot contain symbol-keyed fields.
    step("symbol_key").task({ input: symbolKeyInput, exec: async ({ input }) => input });
    // @ts-expect-error broad object types do not prove a durable plain-object shape.
    step("broad_object").task({ input: broadObject, exec: async ({ input }) => input });
    // @ts-expect-error expression payloads must prove a durable runtime shape.
    step("expr_broad_object").task({ input: broadObjectExpr, exec: async ({ input }) => input });
    // @ts-expect-error Date is not a durable Task input value.
    step("date").task({ input: new Date(), exec: async ({ input }) => input });
    // @ts-expect-error functions are not durable Task input values.
    step("function").task({ input: callback, exec: async ({ input }) => input });
    // @ts-expect-error promises are not durable Task input values.
    step("promise").task({ input: promise, exec: async ({ input }) => input });
    // @ts-expect-error Map is not a durable Task input value.
    step("map").task({ input: new Map<string, string>(), exec: async ({ input }) => input });
    // @ts-expect-error Set is not a durable Task input value.
    step("set").task({ input: new Set<string>(), exec: async ({ input }) => input });
    // @ts-expect-error bigint is not a durable Task input value.
    step("bigint").task({ input: 1n, exec: async ({ input }) => input });
    // @ts-expect-error symbol is not a durable Task input value.
    step("symbol").task({ input: Symbol("input"), exec: async ({ input }) => input });
    return {};
  });
});

test("signal nodes support raw string and schema-backed output", () => {
  defineWorkflow({ name: "typed-signal-output" }).build(({ step }) => {
    const raw = step("raw_signal").signal({ prompt: "Approve?" });
    expectTypeOf(raw.output).toEqualTypeOf<Expr<string>>();

    const structured = step("structured_signal").signal({
      outputSchema: z.object({ approved: z.boolean() }),
      prompt: "Approve?",
    });
    expectTypeOf(structured.output.approved).toEqualTypeOf<Expr<boolean>>();

    step("signal_timeout_message").signal({
      timeout: "1m",
      onTimeout: { message: "Approval timed out" },
      prompt: "Approve?",
    });

    // @ts-expect-error onTimeout has no effect without timeout.
    step("typed_bad_signal_timeout_without_duration").signal({
      onTimeout: { message: "Approval timed out" },
      prompt: "bad",
    });

    return { approved: structured.output.approved, raw: raw.output };
  });
});

test("nested composite callbacks close over root agents", () => {
  defineWorkflow({
    name: "typed-nested-agent-access",
    agents: { worker: { command: "acpx worker" } },
  }).build(({ agents, step }) => {
    step("nested").if({
      condition: true,
      then() {
        step("nested_agent").agent({ agent: agents.worker, prompt: "ok" });
        return {};
      },
      else() { return {}; },
    });
    return {};
  });
});

test("task options accept only string cwd and string env values", () => {
  defineWorkflow({ name: "typed-task-options", inputSchema: z.object({ cwd: z.string(), token: z.string() }) }).build(({ input, step }) => {
    step("options_ok").task({
      input: null,
      cwd: input.cwd,
      env: {
        TOKEN: input.token,
        VALUE: input.token,
      },
      exec: async () => ({ ok: true }),
    });

    step("bad_cwd").task({
      input: null,
      // @ts-expect-error cwd must be a string workflow value.
      cwd: 1,
      exec: async () => ({ ok: true }),
    });

    step("bad_env").task({
      input: null,
      env: {
        // @ts-expect-error env values must be string workflow values.
        VALUE: 1,
      },
      exec: async () => ({ ok: true }),
    });

    return {};
  });
});

test("lift preserves selected output object types", () => {
  defineWorkflow({ name: "typed-lift-selected-object" }).build(({ step }) => {
    const review = step("review").task({
      input: null,
      exec: async () => ({
        ready: true,
        summary: "ok",
        report_path: "/tmp/report.md",
      }),
    });
    const selected = lift(review.output, output => ({
      summary: output.summary,
      report_path: output.report_path,
    }));
    expectTypeOf(selected.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(selected.report_path).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error lift result exposes only returned keys.
    selected.ready;
    return { selected };
  });
});

test("boolean node conditions require boolean workflow values", () => {
  defineWorkflow({ name: "typed-conditions" }).build(({ step }) => {
    const review = step("review").task({
      input: null,
      exec: async () => ({ ok: true, summary: "done" }),
    });
    step("ok_if").if({ condition: review.output.ok, then() { return {}; }, else() { return {}; } });
    step("bad_if").if({
      // @ts-expect-error if condition must be boolean.
      condition: review.output.summary,
      then() { return {}; },
      else() { return {}; },
    });

    step("ok_switch").switch({
      cases: [{ when: review.output.ok, then() { return {}; } }],
      default() { return {}; },
    });
    step("bad_switch").switch({
      cases: [
        {
          // @ts-expect-error switch case condition must be boolean.
          when: review.output.summary,
          // @ts-expect-error the invalid case cannot establish a durable branch callback type.
          then() { return {}; },
        },
      ],
      default() { return {}; },
    });

    return {};
  });
});

test("plain prompts and templates are accepted", () => {
  defineWorkflow({
    name: "typed-template",
    inputSchema: z.object({ title: z.string() }),
    agents: { reviewer: { use: "codex" } },
  }).build(({ input, agents, step }) => {
    step("agent").agent({
      agent: agents.reviewer,
      prompt: template`Review ${input.title}`,
      sessionKey: "plain-session",
    });
    step("agent_template_session").agent({
      agent: agents.reviewer,
      prompt: "Review",
      sessionKey: template`release:${input.title}`,
    });
    step("agent_md_session").agent({
      agent: agents.reviewer,
      prompt: "Review",
      sessionKey: md`
        release:${input.title}
      `,
    });
    return {};
  });
});

test("runtime configuration fields share the Resolvable seam", () => {
  defineWorkflow({
    name: "typed-resolvable-config",
    inputSchema: z.object({
      timeout: z.string(),
      text: z.string(),
      count: z.number(),
      optionalCount: z.number().optional(),
      ready: z.boolean(),
      items: z.array(z.string()),
    }),
    agents: { reviewer: { use: "codex" } },
  }).build(({ input, agents, step }) => {
    step("agent").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: input.timeout,
      agent: agents.reviewer,
      prompt: input.text,
      sessionKey: input.text,
      cwd: input.text,
      env: { VALUE: input.text },
    });
    step("task").task({
      timeout: input.timeout,
      input: { text: input.text },
      cwd: input.text,
      env: { VALUE: input.text },
      execution: { defaultCommandTimeout: input.timeout },
      exec: async ({ input }) => ({ text: input.text }),
    });
    step("signal").signal({
      timeout: input.timeout,
      onTimeout: { message: input.text },
      prompt: input.text,
    });
    step("assert").assert({ condition: input.ready, message: input.text });
    step("parallel").parallel({
      maxConcurrency: input.optionalCount,
      branches: { only() { return {}; } },
    });
    step("fanout").fanout({
      over: input.items,
      strategy: "quorum",
      count: input.count,
      maxConcurrency: input.optionalCount,
      do({ item }) { return { item }; },
    });
    step("literal_concurrency").parallel({
      maxConcurrency: 0,
      branches: { only() { return {}; } },
    });
    step("invalid_concurrency").parallel({
      // @ts-expect-error concurrency limits accept only numeric runtime values.
      maxConcurrency: null,
      branches: { only() { return {}; } },
    });
    return {};
  });
});

test("declaration-time structure stays plain", () => {
  const dynamicString = null as unknown as Expr<string>;

  // @ts-expect-error agent selector is declaration-time structure.
  assertType<AgentDefinitionSpec>({ use: dynamicString });
  // @ts-expect-error top-level agent cwd is static.
  assertType<AgentDefinitionSpec>({ use: "codex", cwd: dynamicString });
  // @ts-expect-error top-level agent env is static.
  assertType<AgentDefinitionSpec>({ use: "codex", env: { VALUE: dynamicString } });
  // @ts-expect-error agent model is declaration-time structure.
  assertType<AgentDefinitionSpec>({ use: "codex", model: dynamicString });
  // @ts-expect-error agent config is declaration-time structure.
  assertType<AgentDefinitionSpec>({ use: "codex", config: { mode: dynamicString } });
  // @ts-expect-error permission mode is declaration-time structure.
  assertType<AgentDefinitionSpec>({ use: "codex", permissionMode: dynamicString });

  defineWorkflow({
    name: "typed-static-structure",
    inputSchema: z.object({ strategy: z.string() }),
    agents: { reviewer: { use: "codex" } },
  }).build(({ input, agents, step }) => {
    // @ts-expect-error node ids are declaration-time structure.
    step(input.strategy);
    step("parallel").parallel({
      // @ts-expect-error strategy is declaration-time structure.
      strategy: input.strategy,
      branches: { only() { return {}; } },
    });
    step("fanout").fanout({
      over: ["item"],
      // @ts-expect-error fanout strategy is declaration-time structure.
      strategy: input.strategy,
      do() { return {}; },
    });
    // @ts-expect-error output schemas are declaration-time structure.
    step("schema").agent({ outputSchema: input.strategy, agent: agents.reviewer, prompt: "review" });
    // @ts-expect-error reusable task targets are declaration-time structure.
    step("target").task({ task: input.strategy, input: null });
    step("invalid_input").task({
      // @ts-expect-error Task input cannot contain raw undefined.
      input: {
        omitted: undefined,
      },
      exec: async () => ({}),
    });
    return {};
  });
});
