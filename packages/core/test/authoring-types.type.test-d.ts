import { assertType, expectTypeOf, test } from "vitest";
import {
  defineWorkflow,
  secret,
  task,
  z,
  type ScopeContext,
  type StepDeclaration,
  type StepInput,
  type AgentMap,
  type AgentDefinitionSpec,
  type AgentRunSpec,
  type AgentToken,
  type TaskStepSpec,
} from "../src/index.js";
import { includes, isEmpty, not, pick, template, where, type Expr, type WorkflowValue } from "@acpus/expression";

test("step declaration object exposes kind methods", () => {
  defineWorkflow({ name: "typed-step-declaration" }).build(({ input, step }) => {
    // @ts-expect-error workflows without inputSchema have no input fields.
    input.repoPath;
    const declaration = step("require_true");
    assertType<StepDeclaration>(declaration);
    assertType<void>(declaration.assert({ condition: true }));
    return {};
  });
});

test("build context exposes run-level meta refs", () => {
  defineWorkflow({ name: "typed-meta" }).build(({ meta }) => {
    assertType<Expr<string>>(meta.runId);
    assertType<Expr<string>>(meta.workflowPath);
    assertType<Expr<string>>(meta.workflowName);
    assertType<Expr<string>>(meta.workspaceDir);
    // @ts-expect-error meta is run-level only.
    meta.nodeId;
    return {
      runId: meta.runId,
      workflowPath: meta.workflowPath,
      workflowName: meta.workflowName,
      workspaceDir: meta.workspaceDir,
    };
  });
});

test("agent run specs require agent tokens", () => {
  const reviewer = null as unknown as AgentToken<"reviewer">;
  const declaration = {} as StepDeclaration;
  declaration.agent({ run: { agent: reviewer, prompt: "ok" } });

  const runSpec: AgentRunSpec = {
    agent: reviewer,
    prompt: "ok",
  };
  const badRunSpec: AgentRunSpec = {
    // @ts-expect-error agent runs accept tokens, not string keys.
    agent: "reviewer",
    prompt: "bad",
  };

  void runSpec;
  void badRunSpec;
});

test("agent tokens are typed from top-level agent keys", () => {
  const extractedAgents = {
    reviewer: { use: "codex", policy: "read" },
  } satisfies AgentMap;

  assertType<AgentDefinitionSpec>({ use: "codex", policy: "read" });
  assertType<AgentDefinitionSpec>({ command: "acpx worker", policy: "full" });
  // @ts-expect-error agent definitions must use either use or command, not both.
  assertType<AgentDefinitionSpec>({
    use: "codex",
    command: "acpx worker",
  });
  // @ts-expect-error model requires an agent use definition.
  assertType<AgentDefinitionSpec>({ model: "gpt-5.4" });
  const commandWithModel = { command: "acpx worker", model: "gpt-5.4" };
  // @ts-expect-error command-backed agents cannot declare model, including non-fresh values.
  assertType<AgentDefinitionSpec>(commandWithModel);
  const irShapedAgent = { kind: "agent_definition", use: "codex" };
  // @ts-expect-error agent definitions must be plain authoring specs, not IR-shaped values.
  assertType<AgentDefinitionSpec>(irShapedAgent);
  // @ts-expect-error AgentMap accepts plain authoring definitions, not IR-shaped definitions.
  ({ reviewer: { kind: "agent_definition", use: "codex" } } satisfies AgentMap);

  defineWorkflow({
    name: "typed-extracted-agent-keys",
    agents: extractedAgents,
  }).build(({ agents, step }) => {
    assertType<AgentToken<"reviewer">>(agents.reviewer);
    step("typed_extracted_agent_key_ok").agent({
      run: {
        agent: agents.reviewer,
        prompt: "ok",
      },
    });
    // @ts-expect-error extracted agents preserve literal keys with satisfies AgentMap.
    agents.missing;
    return {};
  });

  defineWorkflow({
    name: "typed-agent-keys",
    agents: {
      reviewer: { use: "codex", policy: "read" },
      worker: { command: "acpx worker", policy: "full" },
      summarizer: { use: "codex", policy: "read" },
    },
  }).build(({ agents, step }) => {
    assertType<StepDeclaration>(step("typed_agent_key_declaration"));
    assertType<AgentToken<"reviewer">>(agents.reviewer);
    assertType<AgentToken<"worker">>(agents.worker);
    assertType<AgentToken<"summarizer">>(agents.summarizer);

    step("typed_agent_key_ok").agent({
      run: {
        agent: agents.reviewer,
        prompt: "ok",
      },
    });

    step("typed_agent_command_key_ok").agent({
      run: {
        agent: agents.worker,
        prompt: "ok",
      },
    });

    step("typed_agent_summarizer_key_ok").agent({
      run: {
        agent: agents.summarizer,
        prompt: "ok",
      },
    });

    // @ts-expect-error agent reference must come from a declared top-level agent key.
    agents.missing;

    step("typed_agent_nested_scope").if({
      condition: true,
      then: ({ step }) => {
        step("typed_nested_agent_key_ok").agent({
          run: {
            agent: agents.worker,
            prompt: "ok",
          },
        });
        // @ts-expect-error nested scopes use root agent tokens by closure.
        agents.missing;
        return {};
      },
    });
    step("typed_nested_scope_has_no_agents_param").if({
      condition: true,
      // @ts-expect-error composite callbacks do not receive agents; close over root build agents instead.
      then: ({ agents }) => ({}),
    });

    step("typed_agent_switch_scope").switch({
      cases: [
        {
          when: true,
          then: ({ step }) => {
            step("typed_switch_agent_key_ok").agent({
              run: {
                agent: agents.worker,
                prompt: "ok",
              },
            });
            return {};
          },
        },
      ],
    });

    step("typed_agent_parallel_scope").parallel({
      branches: {
        left: {
          outputSchema: z.object({ ok: z.boolean() }),
          do: ({ step }) => {
            step("typed_parallel_agent_key_ok").agent({
              run: {
                agent: agents.worker,
                prompt: "ok",
              },
            });
            return { ok: true };
          },
        },
      },
    });

    step("typed_agent_fanout_scope").fanout({
      over: ["a"],
      itemOutputSchema: z.object({ ok: z.boolean() }),
      do: ({ step }) => {
        step("typed_fanout_agent_key_ok").agent({
          run: {
            agent: agents.worker,
            prompt: "ok",
          },
        });
        return { ok: true };
      },
    });

    step("typed_agent_loop_scope").loop({
      maxIterations: 1,
      outputSchema: z.object({ done: z.boolean() }),
      do: ({ step }) => {
        step("typed_loop_agent_key_ok").agent({
          run: {
            agent: agents.worker,
            prompt: "ok",
          },
        });
        return { done: true };
      },
      stopWhen: ({ result }) => result.done,
    });

    return {};
  });
});

test("agent nodes require declared agents", () => {
  defineWorkflow({ name: "typed-agent-requires-registry" }).build(({ agents, step }) => {
    // @ts-expect-error workflows without top-level agents have no agent tokens.
    agents.reviewer;
    step("typed_agent_without_registry").agent({
      run: {
        // @ts-expect-error agent runs accept tokens, not string keys.
        agent: "reviewer",
        prompt: "bad",
      },
    });

    return {};
  });
});

test("pick preserves selected output key types", () => {
  const ReviewOut = z.object({
    ready: z.boolean(),
    summary: z.string(),
    report_path: z.path(),
  });

  defineWorkflow({ name: "typed-pick" }).build(({ step }) => {
    const review = step("review").task({
      outputSchema: ReviewOut,
      run: {
        input: {},
        exec: async () => ({
          ready: true,
          summary: "ok",
          report_path: "report.md",
        }),
      },
    });

    const picked = pick(review.output, ["ready", "summary"]);
    expectTypeOf(picked.ready).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(picked.summary).toEqualTypeOf<Expr<string>>();

    // @ts-expect-error selected keys must exist on the output object.
    pick(review.output, ["missing"]);

    const fanout = step("items").fanout({
      over: ["a", "b"],
      itemOutputSchema: z.object({ ok: z.boolean() }),
      do: () => ({ ok: true }),
    });

    // @ts-expect-error pick only supports object-like output accessors, not arrays.
    pick(fanout.output, ["ok"]);

    return {
      ...picked,
      report_path: review.output.report_path,
    };
  });
});

test("task run input and reusable task output are strongly typed", () => {
  const PackageOut = z.object({
    packageName: z.string(),
    version: z.string(),
  });

  const reusablePackageTask = task.define({
    inputSchema: PackageOut,
    outputSchema: PackageOut,
    exec: async ({ input, abortSignal }) => {
      assertType<string>(input.version);
      assertType<AbortSignal>(abortSignal);
      // @ts-expect-error reusable task definition input is unwrapped as string.
      assertType<number>(input.version);
      return {
        packageName: input.packageName,
        version: input.version,
      };
    },
  });

  defineWorkflow({
    name: "typed-step-input",
    inputSchema: z.object({
      packageName: z.string(),
      version: z.string(),
    }),
    agents: {
      reviewer: { use: "codex", policy: "read" },
    },
  }).build(({ input, agents, step }) => {
    const nestedScope = ({ step }: ScopeContext) => {
      const first = step("nested_first").task({
        outputSchema: z.object({ packageName: z.string() }),
        run: {
          input: { packageName: input.packageName },
          exec: async ({ input }) => ({ packageName: input.packageName }),
        },
      });

      const branches = step("nested_parallel").parallel({
        branches: {
          left: {
            outputSchema: z.object({ packageName: z.string() }),
            do: () => ({ packageName: first.output.packageName }),
          },
          right: {
            outputSchema: z.object({ version: z.string() }),
            do: () => ({ version: input.version }),
          },
        },
      });

      return {
        packageName: first.output.packageName,
        branches: branches.output,
      };
    };

    const review = step("typed_agent_direct_refs").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      run: {
        agent: agents.reviewer,
        prompt: template`Review ${input.packageName} ${input.version}`,
      },
    });

    const gate = step("typed_signal_direct_refs").signal({
      outputSchema: z.object({ approved: z.boolean() }),
      timeout: "1m",
      onTimeout: { action: "fail", message: "approval timed out" },
      run: {
        prompt: template`Approve ${review.output.ok} for ${input.packageName}`,
      },
    });

    step("typed_bad_signal_timeout_action").signal({
      outputSchema: z.object({ approved: z.boolean() }),
      timeout: "1m",
      // @ts-expect-error signal timeout only supports fail.
      onTimeout: { action: "retry" },
      run: {
        prompt: "bad",
      },
    });

    const inline = step("typed_inline_task_input").task({
      outputSchema: PackageOut,
      run: {
        input: {
          packageName: input.packageName,
          version: input.version,
        },
        exec: async ({ input, abortSignal }) => {
          assertType<string>(input.version);
          assertType<AbortSignal>(abortSignal);
          // @ts-expect-error runtime input is unwrapped as string, not number.
          assertType<number>(input.version);
          return {
            packageName: input.packageName,
            version: input.version,
          };
        },
      },
    });

    const reusable = step("typed_reusable_task_input").task({
      run: {
        task: reusablePackageTask,
        input: {
          packageName: input.packageName,
          version: input.version,
        },
      },
    });

    expectTypeOf(reusable.output.version).toEqualTypeOf<Expr<string>>();
    // @ts-expect-error reusable task output is inferred from task.define as string.
    assertType<Expr<number>>(reusable.output.version);

    // @ts-expect-error reusable tasks require every declared task input field.
    step("typed_reusable_task_missing_input").task({
      run: {
        task: reusablePackageTask,
        input: { packageName: input.packageName },
      },
    });

    step("typed_reusable_task_rejects_output").task({
      run: {
        task: reusablePackageTask,
        input: {
          packageName: input.packageName,
          version: input.version,
        },
      },
      // @ts-expect-error reusable tasks take output schema from task.define.
      outputSchema: PackageOut,
    });

    step("typed_task_rejects_extra_run_field").task({
      run: {
        task: reusablePackageTask,
        input: {
          packageName: input.packageName,
          version: input.version,
        },
        // @ts-expect-error task run config is a closed shape.
        extra: { mode: "strict" },
      },
    });

    const nested = step("typed_nested_scope").if({
      condition: review.output.ok,
      then: nestedScope,
      else: () =>
        ({ packageName: input.packageName, branches: {} }),
    });

    return {
      ok: gate.output.approved,
      version: inline.output.version,
      nested: nested.output,
    };
  });
});

test("workflow values preserve null literals but reject undefined literals", () => {
  assertType<WorkflowValue<any>>({
    label: "pkg",
    nested: { enabled: true, tags: ["a"] },
  });
  assertType<WorkflowValue<null>>(null);
  assertType<WorkflowValue<string | null>>(null);
  assertType<WorkflowValue<{ reason: string | null }>>({ reason: null });

  // @ts-expect-error undefined is not a workflow literal value.
  assertType<WorkflowValue<string | undefined>>(undefined);

  // @ts-expect-error boolean workflow values cannot receive string literals.
  assertType<WorkflowValue<boolean>>("true");

  // @ts-expect-error boolean workflow values cannot receive object literals.
  assertType<WorkflowValue<boolean>>({ ok: true });
});

test("agent run options accept only string cwd and string or secret env values", () => {
  defineWorkflow({
    name: "typed-agent-options",
    inputSchema: z.object({
      packageName: z.string(),
      repoPath: z.path(),
    }),
    agents: {
      reviewer: { use: "codex", policy: "read" },
    },
  }).build(({ input, agents, step }) => {
    const review = step("typed_agent_options").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      run: {
        agent: agents.reviewer,
        prompt: template`Review ${input.packageName}`,
        cwd: input.repoPath,
        env: {
          REVIEW_TOKEN: secret("REVIEW_TOKEN"),
          PACKAGE_NAME: input.packageName,
          STATIC: "true",
        },
      },
    });

    step("typed_bad_agent_cwd").agent({
      run: {
        agent: agents.reviewer,
        prompt: "bad",
        // @ts-expect-error agent cwd must be a string workflow value.
        cwd: 123,
      },
    });

    step("typed_bad_agent_env").agent({
      run: {
        agent: agents.reviewer,
        prompt: "bad",
        env: {
          // @ts-expect-error agent env values must be string workflow values or secrets.
          DEBUG: true,
        },
      },
    });

    return { ok: review.output.ok };
  });
});

test("boolean node conditions require boolean workflow values", () => {
  defineWorkflow({
    name: "typed-boolean-conditions",
    inputSchema: z.object({
      packageName: z.string(),
      shouldRun: z.boolean(),
      branch: z.string(),
      minScore: z.number(),
      allowedTags: z.array(z.string()),
    }),
  }).build(({ input, step }) => {
    const review = step("typed_condition_source").task({
      outputSchema: z.object({
        ok: z.boolean(),
        summary: z.string(),
        branch: z.string(),
        score: z.number(),
        tag: z.string(),
        tags: z.array(z.string()),
      }),
      run: {
        input: { packageName: input.packageName },
        exec: async ({ input }) => ({
          ok: true,
          summary: input.packageName,
          branch: "main",
          score: 1,
          tag: "ready",
          tags: ["ready"],
        }),
      },
    });

    step("typed_assert_direct_ref").assert({
      condition: review.output.ok,
      message: template`Review was not ok`,
    });

    step("typed_assert_where").assert({
      condition: where(review.output, { ok: true }),
      message: template`Review was not ok`,
    });

    // @ts-expect-error where filter fields must match the target field type.
    where(review.output, { ok: "yes" });

    assertType<Expr<boolean>>(where(review.output, {
      ok: input.shouldRun,
      branch: input.branch,
      score: { gte: input.minScore },
    }));

    assertType<Expr<boolean>>(includes(review.output.tags, input.branch));
    assertType<Expr<boolean>>(not(includes([input.branch], review.output.tag)));
    assertType<Expr<boolean>>(includes(input.packageName, "pkg"));
    assertType<Expr<boolean>>(isEmpty(review.output.tags));
    assertType<Expr<boolean>>(isEmpty(input.packageName));

    // @ts-expect-error includes array item must match the collection item type.
    includes(review.output.tags, input.shouldRun);

    // @ts-expect-error includes string collection requires a string value.
    includes(input.packageName, input.shouldRun);

    // @ts-expect-error assert requires a boolean expression, not a string output ref.
    step("typed_assert_string").assert({ condition: input.packageName });

    // @ts-expect-error assert requires a boolean expression, not an object output ref.
    step("typed_assert_object").assert({ condition: review.output });

    const gate = step("typed_if_condition").if({
      condition: input.shouldRun,
      outputSchema: z.object({ ok: z.boolean() }),
      then: () => ({ ok: true }),
      else: () => ({ ok: false }),
    });

    step("typed_if_bad_condition").if({
      // @ts-expect-error if condition must be a boolean workflow value.
      condition: input.packageName,
      then: () => ({}),
    });

    step("typed_switch_condition").switch({
      outputSchema: z.object({ ok: z.boolean() }),
      cases: [{ when: review.output.ok, then: () => ({ ok: true }) }],
      default: () => ({ ok: false }),
    });

    step("typed_switch_bad_condition").switch({
      cases: [
        {
          // @ts-expect-error switch case condition must be a boolean workflow value.
          when: input.packageName,
          then: () => ({}),
        },
      ],
    });

    step("typed_loop_condition").loop({
      maxIterations: 1,
      outputSchema: z.object({ done: z.boolean() }),
      do: () => ({ done: true }),
      stopWhen: ({ result }) => result.done,
      onExhausted: "fail",
    });

    const returnLastLoop = step("typed_loop_return_last").loop({
      maxIterations: 1,
      outputSchema: z.object({ done: z.boolean() }),
      do: () => ({ done: true }),
      stopWhen: ({ result }) => result.done,
      onExhausted: "returnLast",
    });
    expectTypeOf(returnLastLoop.output.done).toEqualTypeOf<Expr<boolean>>();

    step("typed_bad_loop_exhausted").loop({
      maxIterations: 1,
      outputSchema: z.object({ done: z.boolean() }),
      do: () => ({ done: false }),
      stopWhen: ({ result }) => result.done,
      // @ts-expect-error loop exhaustion only supports fail or returnLast.
      onExhausted: "continue",
    });

    step("typed_bad_loop_stop").loop({
      maxIterations: 1,
      outputSchema: z.object({ done: z.boolean() }),
      do: () => ({ done: false }),
      // @ts-expect-error loop stopWhen must return a boolean workflow value.
      stopWhen: () => ({ done: true }),
    });

    return { ok: gate.output.ok };
  });
});

test("task run input accepts only graph-lowerable workflow values", () => {
  const goodInput: StepInput = {
    label: "pkg",
    count: 1,
    nested: { enabled: true, tags: ["a", "b"] },
  };
  assertType<StepInput>(goodInput);

  // @ts-expect-error functions are not graph-lowerable task inputs.
  const badFunctionInput: StepInput = { fn: () => "bad" };

  // @ts-expect-error Date instances are not graph-lowerable task inputs.
  const badDateInput: StepInput = { now: new Date() };

  // @ts-expect-error undefined is not a graph-lowerable task input value.
  const badUndefinedInput: StepInput = { missing: undefined };

  void badFunctionInput;
  void badDateInput;
  void badUndefinedInput;
});

test("task options accept only string cwd and string or secret env values", () => {
  const goodTaskOptions = {
    outputSchema: z.object({ packageName: z.string(), version: z.string() }),
    run: {
      input: { packageName: "core", version: "1.0.0" },
      cwd: "packages/core",
      env: {
        STATIC: "true",
        TOKEN: secret("PACKAGE_TOKEN"),
      },
      exec: async ({ input }) => input,
    },
  } satisfies TaskStepSpec<{ packageName: "core"; version: "1.0.0" }>;
  void goodTaskOptions;

  const badTaskCwd = {
    outputSchema: z.object({ packageName: z.string(), version: z.string() }),
    run: {
      input: { packageName: "core", version: "1.0.0" },
      // @ts-expect-error task cwd must be a string workflow value.
      cwd: 123,
      exec: async ({ input }) => input,
    },
  } satisfies TaskStepSpec<{ packageName: "core"; version: "1.0.0" }>;

  const badTaskEnv = {
    outputSchema: z.object({ packageName: z.string(), version: z.string() }),
    run: {
      input: { packageName: "core", version: "1.0.0" },
      env: {
        // @ts-expect-error task env values must be string workflow values or secrets.
        DEBUG: true,
      },
      exec: async ({ input }) => input,
    },
  } satisfies TaskStepSpec<{ packageName: "core"; version: "1.0.0" }>;

  void badTaskCwd;
  void badTaskEnv;
});
