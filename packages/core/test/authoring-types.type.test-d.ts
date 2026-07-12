import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  task,
  z,
  type AgentDefinitionSpec,
  type AgentMap,
  type AgentStepSpec,
  type AgentToken,
  type JsonObject,
  type JsonValue,
  type ReusableTaskToken,
  type StepDeclaration,
} from "../src/index.js";
import { lift, md, template, type Expr } from "@acpus/expression";

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

  assertType<AgentDefinitionSpec>({ use: "codex", permissionMode: "approve-reads", agentMode: "agent" });
  assertType<AgentDefinitionSpec>({ command: "acpx worker", model: "gpt-5.4", permissionMode: "approve-all", agentMode: "bypassPermissions" });
  // @ts-expect-error agent definitions must use either use or command, not both.
  assertType<AgentDefinitionSpec>({ use: "codex", command: "acpx worker" });

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
      // @ts-expect-error a Task step must choose exactly one execution target.
      exec: async () => ({ ok: true }),
      task: reusablePackageTask,
    });

    return { ok: inline.output.ok, version: reusable.output.version };
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
      input: {},
      cwd: input.cwd,
      env: {
        TOKEN: input.token,
        VALUE: input.token,
      },
      exec: async () => ({ ok: true }),
    });

    // @ts-expect-error cwd must be a string workflow value.
    step("bad_cwd").task({
      input: {},
      cwd: 1,
      exec: async () => ({ ok: true }),
    });

    // @ts-expect-error env values must be string workflow values.
    step("bad_env").task({
      input: {},
      env: {
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
      input: {},
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
      input: {},
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
  // @ts-expect-error agent mode is declaration-time structure.
  assertType<AgentDefinitionSpec>({ use: "codex", agentMode: dynamicString });
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
      // @ts-expect-error the invalid strategy makes the fanout callback output impossible.
      do() { return {}; },
    });
    // @ts-expect-error output schemas are declaration-time structure.
    step("schema").agent({ outputSchema: input.strategy, agent: agents.reviewer, prompt: "review" });
    // @ts-expect-error reusable task targets are declaration-time structure.
    step("target").task({ task: input.strategy, input: {} });
    // @ts-expect-error Task input cannot contain raw undefined.
    step("invalid_input").task({
      input: {
        omitted: undefined,
      },
      exec: async () => ({}),
    });
    return {};
  });
});
