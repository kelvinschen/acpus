import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  secret,
  task,
  z,
  type AgentDefinitionSpec,
  type AgentMap,
  type AgentRunSpec,
  type AgentToken,
  type JsonObject,
  type JsonValue,
  type ReusableTaskToken,
  type StepDeclaration,
  type TaskStepSpec,
} from "../src/index.js";
import { fmap, md, template, type Expr } from "@acpus/expression";

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
  // @ts-expect-error agent definitions use permissionMode, not policy.
  assertType<AgentDefinitionSpec>({ use: "codex", policy: "read" });
  // @ts-expect-error agent definitions must use either use or command, not both.
  assertType<AgentDefinitionSpec>({ use: "codex", command: "acpx worker" });

  defineWorkflow({ name: "typed-agent-keys", agents: extractedAgents }).build(({ agents, step }) => {
    assertType<AgentToken<"reviewer">>(agents.reviewer);
    const raw = step("raw_agent").agent({
      run: { agent: agents.reviewer, prompt: "ok" },
    });
    expectTypeOf(raw.output).toEqualTypeOf<Expr<string>>();

    const structured = step("structured_agent").agent({
      outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
      run: { agent: agents.reviewer, prompt: "ok" },
      retry: { max: 1 },
    });
    expectTypeOf(structured.output.ok).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(structured.output.summary).toEqualTypeOf<Expr<string>>();

    // @ts-expect-error schema-less agents have no output conformance target to repair.
    step("bad_agent_retry").agent({
      run: { agent: agents.reviewer, prompt: "bad" },
      retry: { max: 1 },
    });

    // @ts-expect-error agent reference must come from a declared top-level agent key.
    agents.missing;
    return {};
  });
});

test("agent run specs require agent tokens", () => {
  const reviewer = null as unknown as AgentToken<"reviewer">;
  const declaration = {} as StepDeclaration;
  declaration.agent({ run: { agent: reviewer, prompt: "ok" } });

  const runSpec: AgentRunSpec = { agent: reviewer, prompt: "ok" };
  const badRunSpec: AgentRunSpec = {
    // @ts-expect-error agent runs accept tokens, not string keys.
    agent: "reviewer",
    prompt: "bad",
  };

  void runSpec;
  void badRunSpec;
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
      run: {
        input: { packageName: input.packageName, version: input.version },
        exec: async ({ input }) => {
          assertType<string>(input.version);
          // @ts-expect-error runtime input is unwrapped as string, not number.
          assertType<number>(input.version);
          return { version: input.version, ok: true };
        },
      },
    });
    expectTypeOf(inline.output.version).toEqualTypeOf<Expr<string>>();
    expectTypeOf(inline.output.ok).toEqualTypeOf<Expr<boolean>>();

    const reusable = step("reusable").task({
      run: {
        input: { packageName: input.packageName, version: input.version },
        task: reusablePackageTask,
      },
    });
    expectTypeOf(reusable.output.version).toEqualTypeOf<Expr<string>>();
    expectTypeOf(reusable.output.ok).toEqualTypeOf<Expr<boolean>>();

    return { ok: inline.output.ok, version: reusable.output.version };
  });
});

test("task nodes do not accept workflow-level retry", () => {
  assertType<TaskStepSpec<{}>>({
    run: {
      input: {},
      exec: async () => ({ ok: true }),
    },
    // @ts-expect-error task nodes do not support workflow-level automatic retry.
    retry: { max: 1 },
  });
});

test("signal nodes support raw string and schema-backed output", () => {
  defineWorkflow({ name: "typed-signal-output" }).build(({ step }) => {
    const raw = step("raw_signal").signal({ run: { prompt: "Approve?" } });
    expectTypeOf(raw.output).toEqualTypeOf<Expr<string>>();

    const structured = step("structured_signal").signal({
      outputSchema: z.object({ approved: z.boolean() }),
      run: { prompt: "Approve?" },
    });
    expectTypeOf(structured.output.approved).toEqualTypeOf<Expr<boolean>>();

    step("typed_bad_signal_timeout_action").signal({
      timeout: "1m",
      // @ts-expect-error signal timeout only supports fail.
      onTimeout: { action: "resume" },
      run: { prompt: "bad" },
    });

    step("typed_bad_signal_timeout_without_duration").signal({
      // @ts-expect-error onTimeout has no effect without timeout.
      onTimeout: { action: "fail" },
      run: { prompt: "bad" },
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
        step("nested_agent").agent({ run: { agent: agents.worker, prompt: "ok" } });
        return {};
      },
      else() { return {}; },
    });
    return {};
  });
});

test("task options accept only string cwd and string or secret env values", () => {
  defineWorkflow({ name: "typed-task-options", inputSchema: z.object({ cwd: z.string(), token: z.string() }) }).build(({ input, step }) => {
    step("options_ok").task({
      run: {
        input: {},
        cwd: input.cwd,
        env: {
          TOKEN: secret("TOKEN"),
          VALUE: input.token,
        },
        exec: async () => ({ ok: true }),
      },
    });

    step("bad_cwd").task({
      run: {
        input: {},
        // @ts-expect-error cwd must be a string workflow value.
        cwd: 1,
        exec: async () => ({ ok: true }),
      },
    });

    step("bad_env").task({
      run: {
        input: {},
        env: {
          // @ts-expect-error env values must be strings or secret tokens.
          VALUE: 1,
        },
        exec: async () => ({ ok: true }),
      },
    });

    return {};
  });
});

test("fmap preserves selected output object types", () => {
  defineWorkflow({ name: "typed-fmap-selected-object" }).build(({ step }) => {
    const review = step("review").task({
      run: {
        input: {},
        exec: async () => ({
          ready: true,
          summary: "ok",
          report_path: "/tmp/report.md",
        }),
      },
    });
    const selected = fmap(review.output, output => ({
      summary: output.summary,
      report_path: output.report_path,
    }));
    expectTypeOf(selected.summary).toEqualTypeOf<Expr<string>>();
    expectTypeOf(selected.report_path).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error fmap result exposes only returned keys.
    selected.ready;
    return { selected };
  });
});

test("boolean node conditions require boolean workflow values", () => {
  defineWorkflow({ name: "typed-conditions" }).build(({ step }) => {
    const review = step("review").task({
      run: {
        input: {},
        exec: async () => ({ ok: true, summary: "done" }),
      },
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
      run: {
        agent: agents.reviewer,
        prompt: template`Review ${input.title}`,
        sessionKey: "plain-session",
      },
    });
    step("agent_template_session").agent({
      run: {
        agent: agents.reviewer,
        prompt: "Review",
        sessionKey: template`release:${input.title}`,
      },
    });
    step("agent_md_session").agent({
      run: {
        agent: agents.reviewer,
        prompt: "Review",
        sessionKey: md`
          release:${input.title}
        `,
      },
    });
    return {};
  });
});
