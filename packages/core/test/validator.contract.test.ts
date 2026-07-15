import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type WorkflowIR } from "../src/ir.js";

function minimalWorkflow(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    irVersion: 5,
    name: "minimal",
    agents: {},
    root: { output: { kind: "object", fields: {} }, nodes: [] },

    diagnostics: [],
    ...overrides,
  };
}

const inlineTaskTarget = { kind: "inline" as const, source: "async function task() { return {}; }" };

function taskNode(id: string, input: Record<string, any> = {}) {
  return {
    id,
    kind: "task" as const,
    run: { input, target: inlineTaskTarget },
  };
}

describe("WorkflowIR diagnostics contract", () => {
  it("owns the complete ID001 diagnostic contract", () => {
    expect(validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{ id: "bad id", kind: "assert", condition: { kind: "literal", value: true } }],
      },
    }))).toEqual([{
      code: "ID001",
      severity: "error",
      message: "Invalid node id 'bad id'. Expected /^[A-Za-z_][A-Za-z0-9_-]*$/.",
      path: "root.nodes.bad id",
      hint: "Use a compile-time string literal for the step id; runtime Expr values are not allowed in node ids.",
    }]);
  });

  it("accepts optional workflow description metadata", () => {
    expect(validateWorkflowIR(minimalWorkflow({
      description: "Summarize workflow intent for operators.",
    }))).toEqual([]);
  });

  it("accepts agent sessionKey templates", () => {
    const ir = minimalWorkflow({
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "review",
          kind: "agent",
          run: {
            agent: "reviewer",
            prompt: { kind: "literal", value: "" },
            sessionKey: { kind: "template", parts: [{ kind: "text", value: "shared" }] },
          },
        }],
      },
    });

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("validates required output even when scope nodes are malformed", () => {
    expect(validateWorkflowIR(minimalWorkflow({
      root: { nodes: "bad" } as any,
    }))).toEqual([
      {
        code: "IR002",
        severity: "error",
        message: "Scope nodes must be an array.",
        path: "root.nodes",
      },
      {
        code: "IR002",
        severity: "error",
        message: "Scope output is required.",
        path: "root.output",
      },
    ]);

    expect(validateWorkflowIR(minimalWorkflow({
      root: { nodes: "bad", output: "bad" } as any,
    }))).toEqual([
      {
        code: "IR002",
        severity: "error",
        message: "Scope nodes must be an array.",
        path: "root.nodes",
      },
      {
        code: "E004",
        severity: "error",
        message: "Expression must be an object with kind.",
        path: "root.output",
      },
    ]);
  });

  it.each([
    {
      name: "agent sessionKey",
      code: "E000",
      path: "root.nodes.review.run.sessionKey",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      node: {
        id: "review",
        kind: "agent",
        run: { agent: "reviewer", prompt: { kind: "literal", value: "review" }, sessionKey: null },
      },
    },
    {
      name: "agent cwd",
      code: "E000",
      path: "root.nodes.review.run.cwd",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      node: {
        id: "review",
        kind: "agent",
        run: { agent: "reviewer", prompt: { kind: "literal", value: "review" }, cwd: null },
      },
    },
    {
      name: "task cwd",
      code: "E000",
      path: "root.nodes.build.run.cwd",
      node: { ...taskNode("build"), run: { ...taskNode("build").run, cwd: null } },
    },
    {
      name: "task execution",
      code: "T006",
      path: "root.nodes.build.run.execution",
      node: { ...taskNode("build"), run: { ...taskNode("build").run, execution: null } },
    },
    {
      name: "assert message",
      code: "E000",
      path: "root.nodes.check.message",
      node: { id: "check", kind: "assert", condition: { kind: "literal", value: true }, message: null },
    },
    {
      name: "signal onTimeout",
      code: "S001",
      path: "root.nodes.approve.onTimeout",
      node: {
        id: "approve",
        kind: "signal",
        timeout: { kind: "literal", value: "1m" },
        onTimeout: null,
        run: { prompt: { kind: "literal", value: "approve" } },
      },
    },
  ])("rejects explicit null for optional $name", ({ code, path, agents, node }) => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      ...(agents === undefined ? {} : { agents: agents as WorkflowIR["agents"] }),
      root: { output: { kind: "object", fields: {} }, nodes: [node as WorkflowIR["root"]["nodes"][number]] },
    }));

    expect(diagnostics).toContainEqual(expect.objectContaining({ code, path }));
  });

  it("accepts expression callback-source calls through the workflow validator", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "callback_expression",
      agents: {},
      root: {
        nodes: [],
        output: { kind: "object", fields: {
          score: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["input", "item"] },
              { kind: "literal", value: "item => item.score" },
            ],
          },
        } },
      },

      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("returns stable diagnostic codes and paths for invalid IR", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad workflow name",
      inputSchema: {
        kind: "object",
        fields: { id: { kind: "string" } },
        required: ["missing"],
        additionalProperties: false,
      },
      agents: {},
      root: {
        nodes: [
          {
            id: "review",
            kind: "agent",
            run: {
              agent: "reviewer",
              prompt: { kind: "literal", value: "" },
            },
          },
          {
            id: "review",
            kind: "assert",
            condition: { kind: "ref", path: [] },
          },
        ],
        output: { kind: "object", fields: {
          bad: { kind: "ref", path: [] },
        } },
      },

      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "W002",
      "SC001",
      "A001",
      "ID002",
      "E001",
      "E001",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A001",
      path: "root.nodes.review.run.agent",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "SC001",
      path: "inputSchema.required.0",
    }));
  });

  it("validates parallel and fanout strategy invariants", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_strategy",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "empty_race",
            kind: "parallel",
            strategy: "race",
            branches: {},
          },
          {
            id: "bad_over",
            kind: "fanout",
            strategy: "all",
            count: 2,
            over: { kind: "literal", value: "abc" },
            do: { nodes: [], output: { kind: "object", fields: {} } },
          } as any,
          {
            id: "missing_count",
            kind: "fanout",
            strategy: "quorum",
            over: { kind: "array", items: [] },
            do: { nodes: [], output: { kind: "object", fields: {} } },
          } as any,
        ],
      },

      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "P002",
      "F003",
      "F004",
      "F002",
    ]);
  });

  it("validates agent definition IR invariants", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_agents",
      agents: {
        missing_use: {
          kind: "agent_definition",
          model: "gpt-5.4",
        },
        command_with_model: {
          kind: "agent_command",
          command: "acpx worker",
          model: "gpt-5.4",
        },
        extra_definition_field: {
          kind: "agent_definition",
          use: "codex",
          extra: true,
        },
        extra_command_field: {
          kind: "agent_command",
          command: "acpx worker",
          extra: true,
        },
        bad_permission: {
          kind: "agent_definition",
          use: "codex",
          permissionMode: "full",
        },
        bad_mode: {
          kind: "agent_command",
          command: "acpx worker",
          agentMode: "",
        },
        bad_trace: {
          kind: "agent_definition",
          use: "codex",
          trace: "yes",
        },
        bad_kind: {
          kind: "agent_builtin",
          use: "codex",
        },
      } as any,
      root: { output: { kind: "object", fields: {} }, nodes: [] },

      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "A002",
      "IR001",
      "IR001",
      "A002",
      "A002",
      "A002",
      "A002",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.missing_use.use",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "IR001",
      path: "agents.extra_definition_field.extra",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "IR001",
      path: "agents.extra_command_field.extra",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.bad_permission.permissionMode",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.bad_mode.agentMode",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.bad_trace.trace",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.bad_kind",
    }));
  });

  it("validates literal constraints on resolvable integer fields", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "zero_parallel",
            kind: "parallel",
            strategy: "all",
            maxConcurrency: { kind: "literal", value: 0 },
            branches: { only: { output: { kind: "object", fields: {} }, nodes: [] } },
          },
          {
            id: "bad_parallel",
            kind: "parallel",
            strategy: "all",
            maxConcurrency: { kind: "literal", value: -1 },
            branches: { only: { output: { kind: "object", fields: {} }, nodes: [] } },
          },
          {
            id: "bad_fanout",
            kind: "fanout",
            strategy: "quorum",
            count: { kind: "literal", value: 0 },
            maxConcurrency: { kind: "literal", value: "many" },
            over: { kind: "array", items: [] },
            do: { output: { kind: "object", fields: {} }, nodes: [] },
          },
        ],
      },
    }));

    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.path])).toEqual([
      ["P001", "root.nodes.bad_parallel.maxConcurrency"],
      ["F002", "root.nodes.bad_fanout.count"],
      ["F001", "root.nodes.bad_fanout.maxConcurrency"],
    ]);
  });

  it("validates node timeout duration strings", () => {
    const target = { kind: "inline" as const, source: "async function task() { return {}; }" };

    const diagnostics = validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "agent_non_string",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: 1000 },
          },
          {
            id: "task_decimal",
            kind: "task",
            run: { input: {}, target },
            timeout: { kind: "literal", value: "1.5s" },
          },
          {
            id: "signal_negative",
            kind: "signal",
            run: { prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "-1s" },
          },
          {
            id: "agent_spaced",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "5 m" },
          },
          {
            id: "task_compound",
            kind: "task",
            run: { input: {}, target },
            timeout: { kind: "literal", value: "1m30s" },
          },
          {
            id: "task_out_of_range",
            kind: "task",
            run: { input: {}, target },
            timeout: { kind: "literal", value: "9007199254740991s" },
          },
        ],
      },
    } as any));

    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.path])).toEqual([
      ["IR002", "root.nodes.agent_non_string.timeout"],
      ["IR002", "root.nodes.task_decimal.timeout"],
      ["IR002", "root.nodes.signal_negative.timeout"],
      ["IR002", "root.nodes.agent_spaced.timeout"],
      ["IR002", "root.nodes.task_compound.timeout"],
      ["IR002", "root.nodes.task_out_of_range.timeout"],
    ]);
  });

  it("accepts supported timeout duration strings", () => {
    const target = { kind: "inline" as const, source: "async function task() { return {}; }" };

    const diagnostics = validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "agent_milliseconds",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "500ms" },
          },
          {
            id: "task_seconds",
            kind: "task",
            run: { input: {}, target },
            timeout: { kind: "literal", value: "30s" },
          },
          {
            id: "signal_minutes",
            kind: "signal",
            run: { prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "5m" },
          },
          {
            id: "task_default_milliseconds",
            kind: "task",
            run: { input: {}, target, execution: { defaultCommandTimeout: { kind: "literal", value: "1000" } } },
          },
          {
            id: "agent_hours",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "1h" },
          },
          {
            id: "signal_days",
            kind: "signal",
            run: { prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "1d" },
          },
        ],
      },
    }));

    expect(diagnostics).toEqual([]);
  });

  it("validates task default command timeout duration strings", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "bad_command_timeout",
          kind: "task",
          run: {
            input: {},
            target: { kind: "inline", source: "async function task() { return {}; }" },
            execution: { defaultCommandTimeout: { kind: "literal", value: "1m30s" } },
          },
        }],
      },
    }));

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "T006", path: "root.nodes.bad_command_timeout.run.execution.defaultCommandTimeout" }),
    ]);
  });

  it("validates signal timeout invariants", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_completion",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "missing_timeout",
            kind: "signal",
            run: { prompt: { kind: "literal", value: "" } },
            onTimeout: {},
          } as any,
          {
            id: "bad_timeout_message",
            kind: "signal",
            run: { prompt: { kind: "literal", value: "" } },
            timeout: { kind: "literal", value: "1m" },
            onTimeout: { message: { kind: "literal", value: 123 } },
          } as any,
        ],
      },

      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["S001", "S001"]);
  });

  it("validates required aligned IR fields", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_required_fields",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "missing_assert_condition",
            kind: "assert",
            condition: undefined,
          },
          {
            id: "literal_without_value",
            kind: "assert",
            condition: { kind: "literal" },
          },
          {
            id: "if_without_else",
            kind: "if",
            condition: { kind: "literal", value: true },
            then: { nodes: [], output: { kind: "object", fields: {} } },
          },
          {
            id: "switch_without_default",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], output: { kind: "object", fields: {} } } }],
          },
          {
            id: "loop_without_state",
            kind: "loop",
            do: { nodes: [], output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } } },
          },
        ],
      },

      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "E000",
      "E003",
      "G002",
      "G003",
      "E000",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "G002",
      path: "root.nodes.if_without_else.else",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "G003",
      path: "root.nodes.switch_without_default.default",
    }));
  });

  it("rejects fields outside the closed IR shape", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "closed_shape",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "review",
            kind: "agent",
            run: {
              agent: "reviewer",
              use: "reviewer",
              session: { key: { kind: "literal", value: "" } },
              prompt: { kind: "literal", value: "" },
            },
          },
          {
            id: "assert_ready",
            kind: "assert",
            condition: { kind: "literal", value: true },
            that: { kind: "literal", value: true },
          },
          {
            id: "gate",
            kind: "if",
            condition: { kind: "literal", value: true },
            when: { kind: "literal", value: true },
            then: { nodes: [], output: { kind: "object", fields: {} } },
            otherwise: { nodes: [], output: { kind: "object", fields: {} } },
          },
          {
            id: "route",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], output: { kind: "object", fields: {} } } }],
            default: { nodes: [], output: { kind: "object", fields: {} } },
            otherwise: { nodes: [], output: { kind: "object", fields: {} } },
          },
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: { nodes: [], output: { kind: "object", fields: {} } },
          },
          {
            id: "retry",
            kind: "loop",
            state: { kind: "object", fields: {} },
            initial: { kind: "object", fields: {} },
            maxIterations: { kind: "literal", value: 1 },
            do: { nodes: [], output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } } },
            stopWhen: { kind: "literal", value: true },
            until: { kind: "literal", value: true },
          },
        ],
      },

      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR001", path: "root.nodes.review.run.use" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.review.run.session" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.assert_ready.that" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.gate.when" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.gate.otherwise" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.route.otherwise" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.retry.initial" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.retry.maxIterations" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.retry.stopWhen" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.retry.until" }),
    ]));
  });

  it("rejects malformed loop transition output contracts", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "missing_stop",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: { nodes: [], output: { kind: "object", fields: { state: { kind: "object", fields: {} } } } },
          },
          {
            id: "extra_transition",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: { nodes: [], output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true }, debug: { kind: "literal", value: 1 } } } },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "E000", path: "root.nodes.missing_stop.do.output.fields.stop" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.extra_transition.do.output.fields.debug" }),
    ]));
  });

  it("returns diagnostics for malformed expr, template, and env IR", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "malformed_nested_ir",
      agents: {
        worker: {
          kind: "agent_definition",
          use: "codex",
          env: {
            BAD_EXPR: 1,
            BAD_OBJECT: { kind: "literal", value: "not-static" },
          },
        },
      },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "bad_assert",
            kind: "assert",
            condition: "ready",
            message: { kind: "template", parts: [{ kind: "text", value: 1 }, { kind: "expr" }, { kind: "bogus" }] },
          },
          {
            id: "bad_signal",
            kind: "signal",
            outputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
            run: { prompt: { kind: "template" } },
          },
          {
            id: "bad_fanout",
            kind: "fanout",
            strategy: "all",
            do: { nodes: [], output: { kind: "object", fields: {} } },
          },
        ],
      },

      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "E004", path: "agents.worker.env.BAD_EXPR" }),
      expect.objectContaining({ code: "E004", path: "agents.worker.env.BAD_OBJECT" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_assert.condition" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_assert.message.parts.0.value" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_assert.message.parts.1.expr" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_assert.message.parts.2.kind" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_signal.run.prompt.parts" }),
      expect.objectContaining({ code: "E000", path: "root.nodes.bad_fanout.over" }),
    ]));
  });

  it("rejects unknown task run fields in serialized IR", () => {
    const ir = minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "run_task",
          kind: "task",
          run: {
            input: {},
            target: { kind: "inline", source: "async function task() {}" },
            unexpected: { mode: "strict" },
          } as any,
        }],
      },
    });

    expect(validateWorkflowIR(ir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR001", path: "root.nodes.run_task.run.unexpected" }),
    ]));
  });

  it("validates task module target descriptors", () => {
    const ir = minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "run_task",
          kind: "task",
          run: {
            input: {},
            target: {
              kind: "module",
              specifier: "",
              exportName: "",
              referrer: { path: "../workflow.ts" },
            },
          },
        }],
      },
    } as any);

    expect(validateWorkflowIR(ir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "T007", path: "root.nodes.run_task.run.target.specifier" }),
      expect.objectContaining({ code: "T007", path: "root.nodes.run_task.run.target.exportName" }),
      expect.objectContaining({ code: "T007", path: "root.nodes.run_task.run.target.referrer.path" }),
    ]));
  });

  it("validates SchemaIR as a closed recursive union", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_schema",
      inputSchema: {
        kind: "object",
        fields: {
          age: { kind: "integer" },
          bad: { kind: "mystery" },
          tags: { kind: "array" },
          names: { kind: "array", item: { kind: "string", extra: true } },
          open: { kind: "object", fields: {}, required: [], additionalProperties: "yes" },
        },
        required: ["missing"],
        additionalProperties: false,
        extra: true,
      } as any,
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [] },

      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR001", path: "inputSchema.extra" }),
      expect.objectContaining({ code: "SC001", path: "inputSchema.required.0" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.fields.age.kind" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.fields.bad.kind" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.fields.tags.item" }),
      expect.objectContaining({ code: "IR001", path: "inputSchema.fields.names.item.extra" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.fields.open.additionalProperties" }),
    ]));
  });

  it("validates literal, enum, unknown, and closed schema variants", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "bad_schema_variants",
      inputSchema: {
        kind: "union",
        variants: [
          { kind: "literal", value: {} },
          { kind: "enum", values: ["ok", {}] },
          { kind: "mystery" },
          { kind: "string", extra: true },
        ],
      } as any,
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [] },

      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.0.value" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.1.values.1" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.2.kind" }),
      expect.objectContaining({ code: "IR001", path: "inputSchema.variants.3.extra" }),
    ]));
  });

  it("accepts valid recursive core-only SchemaIR", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "valid_recursive_schema",
      inputSchema: {
        kind: "object",
        fields: {
          file: { kind: "string" },
          home: { kind: "string" },
          tags: { kind: "array", item: { kind: "string" } },
          config: { kind: "record", value: { kind: "union", variants: [{ kind: "string" }, { kind: "number" }, { kind: "null" }] } },
        },
        required: ["file", "home"],
        additionalProperties: false,
      },
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [] },

      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("validates the root workflow output", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [],
        output: { kind: "object", fields: { bad: { kind: "ref", path: [] } } },
      },
    }));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "E001",
      path: "root.output.fields.bad.path",
    }));
  });

  it("rejects self, later sibling, and missing node refs", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          taskNode("self_ref", {
            own: { kind: "ref", path: ["nodes", "self_ref", "output", "id"] },
          }),
          taskNode("later_ref", {
            later: { kind: "ref", path: ["nodes", "later", "output", "id"] },
          }),
          taskNode("later"),
          taskNode("missing_ref", {
            missing: { kind: "ref", path: ["nodes", "missing", "output", "id"] },
          }),
        ],
      },
    }));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.self_ref.run.input.own.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.later_ref.run.input.later.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.missing_ref.run.input.missing.path" }),
    ]));
  });

  it("rejects node refs that do not project through output", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          taskNode("first"),
          taskNode("bad_bare", {
            first: { kind: "ref", path: ["nodes", "first"] },
          }),
          taskNode("bad_status", {
            status: { kind: "ref", path: ["nodes", "first", "status"] },
          }),
        ],
      },
    }));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_bare.run.input.first.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_status.run.input.status.path" }),
    ]));
  });

  it("rejects root output expressions that reference node internals", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [taskNode("first")],
        output: { kind: "object", fields: {
          bad: { kind: "ref", path: ["nodes", "first", "run", "target"] },
        } },
      },
    }));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "IR003",
      path: "root.output.fields.bad.path",
    }));
  });

  it("allows child scopes to reference parent nodes and rejects parent access to child internals", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          taskNode("parent"),
          {
            id: "gate",
            kind: "if",
            condition: { kind: "literal", value: true },
            then: {
              nodes: [
                taskNode("child", {
                  parent: { kind: "ref", path: ["nodes", "parent", "output", "id"] },
                }),
              ],
              output: { kind: "object", fields: {
                child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
              } },
            },
            else: { nodes: [], output: { kind: "object", fields: {} } },
          },
          taskNode("bad_child_internal", {
            child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
          }),
        ],
        output: { kind: "object", fields: {
          child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
        } },
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_child_internal.run.input.child.path" }),
      expect.objectContaining({ code: "IR003", path: "root.output.fields.child.path" }),
    ]));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "IR003",
      path: "root.nodes.gate.then.nodes.child.run.input.parent.path",
    }));
  });

  it("rejects sibling parallel branch and switch case node refs", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "branches",
            kind: "parallel",
            strategy: "all",
            branches: {
              left: {
                nodes: [taskNode("left_task")],
                output: { kind: "object", fields: { value: { kind: "ref", path: ["nodes", "left_task", "output", "value"] } } },
              },
              right: {
                nodes: [],
                output: { kind: "object", fields: { value: { kind: "ref", path: ["nodes", "left_task", "output", "value"] } } },
              },
            },
          },
          {
            id: "route",
            kind: "switch",
            cases: [
              {
                when: { kind: "literal", value: true },
                then: {
                  nodes: [taskNode("case_task")],
                  output: { kind: "object", fields: { value: { kind: "ref", path: ["nodes", "case_task", "output", "value"] } } },
                },
              },
              {
                when: { kind: "literal", value: false },
                then: {
                  nodes: [],
                  output: { kind: "object", fields: { value: { kind: "ref", path: ["nodes", "case_task", "output", "value"] } } },
                },
              },
            ],
            default: { nodes: [], output: { kind: "object", fields: {} } },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.branches.branches.right.output.fields.value.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.route.cases.1.then.output.fields.value.path" }),
    ]));
  });

  it("rejects fanout and loop local refs outside their owning scope", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: {
              nodes: [],
              output: { kind: "object", fields: {
                missing: { kind: "ref", path: ["nodes", "missing", "output", "id"] },
              } },
            },
          },
          taskNode("bad_fanout_local", {
            item: { kind: "ref", path: ["fanout", "items", "item", "id"] },
          }),
          {
            id: "retry",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: {
              nodes: [],
              output: { kind: "object", fields: {
                state: { kind: "ref", path: ["loop", "other", "state"] },
                stop: { kind: "ref", path: ["loop", "retry", "state", "done"] },
              } },
            },
          },
          taskNode("bad_loop_local", {
            state: { kind: "ref", path: ["loop", "retry", "state", "id"] },
          }),
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.items.do.output.fields.missing.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_fanout_local.run.input.item.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.retry.do.output.fields.state.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_loop_local.run.input.state.path" }),
    ]));
  });

  it("rejects unsupported fanout and loop local ref members", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: {
              nodes: [],
              output: { kind: "object", fields: {
                bad: { kind: "ref", path: ["fanout", "items", "output"] },
              } },
            },
          },
          {
            id: "retry",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: {
              nodes: [],
              output: { kind: "object", fields: {
                state: { kind: "object", fields: {} },
                stop: { kind: "ref", path: ["loop", "retry", "item"] },
              } },
            },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.items.do.output.fields.bad.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.retry.do.output.fields.stop.path" }),
    ]));
  });

  it("returns diagnostics instead of throwing for malformed top-level containers", () => {
    const malformed = {
      irVersion: 5,
      name: "malformed",
      agents: [],
      root: "bad",
      diagnostics: {},
    };

    expect(() => validateWorkflowIR(malformed as any)).not.toThrow();
    expect(validateWorkflowIR(malformed as any)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR002", path: "agents" }),
      expect.objectContaining({ code: "IR002", path: "diagnostics" }),
      expect.objectContaining({ code: "IR002", path: "root" }),
    ]));
  });

  it("detects sparse arrays in core-owned IR arrays", () => {
    const nodes = new Array(1);
    expect(validateWorkflowIR(minimalWorkflow({ root: { nodes } as any }))).toContainEqual(expect.objectContaining({
      code: "IR002",
      path: "root.nodes.0",
    }));

    const cases = new Array(1);
    expect(validateWorkflowIR(minimalWorkflow({
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "route",
          kind: "switch",
          cases,
        }],
      },
    } as any))).toContainEqual(expect.objectContaining({
      code: "IR002",
      path: "root.nodes.route.cases.0",
    }));

    const parts = new Array(1);
    expect(validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "review",
          kind: "agent",
          run: {
            agent: "reviewer",
            prompt: { kind: "template", parts },
          },
        }],
      },
    } as any))).toContainEqual(expect.objectContaining({
      code: "E004",
      path: "root.nodes.review.run.prompt.parts.0",
    }));
  });
});
