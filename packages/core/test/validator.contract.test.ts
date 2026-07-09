import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type WorkflowIR } from "../src/ir.js";

function minimalWorkflow(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    irVersion: 2,
    name: "minimal",
    agents: {},
    root: { nodes: [] },
    outputs: {},
    lock: { acpusCoreVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
    diagnostics: [],
    ...overrides,
  };
}

const inlineTaskTarget = { kind: "inline" as const, runtime: "node" as const, source: "async function task() { return {}; }" };

function taskNode(id: string, input: Record<string, any> = {}) {
  return {
    id,
    kind: "task" as const,
    run: { kind: "task_run" as const, input, target: inlineTaskTarget },
  };
}

describe("WorkflowIR diagnostics contract", () => {
  it("accepts optional workflow description metadata", () => {
    expect(validateWorkflowIR(minimalWorkflow({
      description: "Summarize workflow intent for operators.",
    }))).toEqual([]);
  });

  it("accepts agent sessionKey templates", () => {
    const ir = minimalWorkflow({
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: {
        nodes: [{
          id: "review",
          kind: "agent",
          run: {
            kind: "agent_run",
            agent: "reviewer",
            prompt: { kind: "template", parts: [] },
            sessionKey: { kind: "template", parts: [{ kind: "text", value: "shared" }] },
          },
        }],
      },
    });

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("accepts expression callback-source calls through the workflow validator", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "callback_expression",
      agents: {},
      root: {
        nodes: [],
        outputs: {
          score: {
            kind: "call",
            fn: "fmap",
            args: [
              { kind: "ref", path: ["input", "item"] },
              { kind: "literal", value: "item => item.score" },
            ],
          },
        },
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("returns stable diagnostic codes and paths for invalid IR", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
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
              kind: "agent_run",
              agent: "reviewer",
              prompt: { kind: "template", parts: [] },
            },
          },
          {
            id: "review",
            kind: "assert",
            condition: { kind: "ref", path: [] },
          },
        ],
        outputs: {
          bad: { kind: "ref", path: [] },
        },
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
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
      irVersion: 2,
      name: "bad_strategy",
      agents: {},
      root: {
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
            do: { nodes: [], outputs: {} },
          } as any,
          {
            id: "missing_count",
            kind: "fanout",
            strategy: "quorum",
            over: { kind: "array", items: [] },
            do: { nodes: [], outputs: {} },
          } as any,
        ],
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
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
      irVersion: 2,
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
        bad_kind: {
          kind: "agent_builtin",
          use: "codex",
        },
      } as any,
      root: { nodes: [] },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
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
      path: "agents.bad_kind",
    }));
  });

  it("validates current retry IR contract", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        nodes: [
          {
            id: "agent_without_schema_retry",
            kind: "agent",
            run: {
              kind: "agent_run",
              agent: "reviewer",
              prompt: { kind: "template", parts: [] },
            },
            retry: { max: 1 },
          },
          {
            id: "agent_bad_retry_shape",
            kind: "agent",
            outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
            run: {
              kind: "agent_run",
              agent: "reviewer",
              prompt: { kind: "template", parts: [] },
            },
            retry: { max: 1, on: ["output_conformance"], backoff: "linear" },
          },
          {
            id: "task_with_retry",
            kind: "task",
            run: {
              kind: "task_run",
              input: {},
              target: { kind: "inline", runtime: "node", source: "async function task() { return {}; }" },
            },
            retry: { max: 1 },
          },
        ],
      },
    } as any));

    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.path])).toEqual([
      ["IR001", "root.nodes.agent_without_schema_retry.retry"],
      ["IR001", "root.nodes.agent_bad_retry_shape.retry.on"],
      ["IR001", "root.nodes.agent_bad_retry_shape.retry.backoff"],
      ["IR001", "root.nodes.task_with_retry.retry"],
    ]);
  });

  it("validates node timeout duration strings", () => {
    const target = { kind: "inline" as const, runtime: "node" as const, source: "async function task() { return {}; }" };

    const diagnostics = validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        nodes: [
          {
            id: "agent_non_string",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
            timeout: 1000,
          },
          {
            id: "task_decimal",
            kind: "task",
            run: { kind: "task_run", input: {}, target },
            timeout: "1.5s",
          },
          {
            id: "signal_negative",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
            timeout: "-1s",
          },
          {
            id: "agent_spaced",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
            timeout: "5 m",
          },
          {
            id: "task_compound",
            kind: "task",
            run: { kind: "task_run", input: {}, target },
            timeout: "1m30s",
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
    ]);
  });

  it("accepts supported timeout duration strings", () => {
    const target = { kind: "inline" as const, runtime: "node" as const, source: "async function task() { return {}; }" };

    const diagnostics = validateWorkflowIR(minimalWorkflow({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
        },
      },
      root: {
        nodes: [
          {
            id: "agent_milliseconds",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
            timeout: "500ms",
          },
          {
            id: "task_seconds",
            kind: "task",
            run: { kind: "task_run", input: {}, target },
            timeout: "30s",
          },
          {
            id: "signal_minutes",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
            timeout: "5m",
          },
          {
            id: "task_default_milliseconds",
            kind: "task",
            run: { kind: "task_run", input: {}, target, execution: { defaultCommandTimeout: "1000" } },
          },
          {
            id: "agent_hours",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
            timeout: "1h",
          },
        ],
      },
    }));

    expect(diagnostics).toEqual([]);
  });

  it("validates task default command timeout duration strings", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [{
          id: "bad_command_timeout",
          kind: "task",
          run: {
            kind: "task_run",
            input: {},
            target: { kind: "inline", runtime: "node", source: "async function task() { return {}; }" },
            execution: { defaultCommandTimeout: "1m30s" },
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
      irVersion: 2,
      name: "bad_completion",
      agents: {},
      root: {
        nodes: [
          {
            id: "bad_timeout",
            kind: "signal",
            outputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
            timeout: "1m",
            onTimeout: { action: "retry" },
          } as any,
          {
            id: "missing_timeout",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
            onTimeout: { action: "fail" },
          } as any,
          {
            id: "bad_timeout_message",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
            timeout: "1m",
            onTimeout: { action: "fail", message: 123 },
          } as any,
        ],
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["S001", "S001", "S001"]);
  });

  it("validates required aligned IR fields", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "bad_required_fields",
      agents: {},
      root: {
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
            then: { nodes: [], outputs: {} },
          },
          {
            id: "switch_without_default",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: {} } }],
          },
          {
            id: "loop_without_state",
            kind: "loop",
            do: { nodes: [], outputs: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } },
          },
        ],
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
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
      irVersion: 2,
      name: "closed_shape",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: {
        nodes: [
          {
            id: "review",
            kind: "agent",
            run: {
              kind: "agent_run",
              agent: "reviewer",
              use: "reviewer",
              session: { key: { kind: "template", parts: [] } },
              prompt: { kind: "template", parts: [] },
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
            then: { nodes: [], outputs: {} },
            otherwise: { nodes: [], outputs: {} },
          },
          {
            id: "route",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: {} } }],
            default: { nodes: [], outputs: {} },
            otherwise: { nodes: [], outputs: {} },
          },
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: { nodes: [], outputs: {} },
          },
          {
            id: "retry",
            kind: "loop",
            state: { kind: "object", fields: {} },
            initial: { kind: "object", fields: {} },
            maxIterations: { kind: "literal", value: 1 },
            do: { nodes: [], outputs: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } },
            stopWhen: { kind: "literal", value: true },
            until: { kind: "literal", value: true },
          },
        ],
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
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
        nodes: [
          {
            id: "missing_stop",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: { nodes: [], outputs: { state: { kind: "object", fields: {} } } },
          },
          {
            id: "extra_transition",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: { nodes: [], outputs: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true }, debug: { kind: "literal", value: 1 } } },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "E000", path: "root.nodes.missing_stop.do.outputs.stop" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.extra_transition.do.outputs.debug" }),
    ]));
  });

  it("returns diagnostics for malformed expr, template, env, and secret IR", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "malformed_nested_ir",
      agents: {
        worker: {
          kind: "agent_definition",
          use: "codex",
          env: {
            BAD_EXPR: "raw",
            BAD_SECRET: { kind: "secret" },
          },
        },
      },
      root: {
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
            run: { kind: "signal_run", prompt: { kind: "template" } },
          },
          {
            id: "bad_fanout",
            kind: "fanout",
            strategy: "all",
            do: { nodes: [], outputs: {} },
          },
        ],
      },
      outputs: {},
      lock: {
        acpusCoreVersion: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "E004", path: "agents.worker.env.BAD_EXPR" }),
      expect.objectContaining({ code: "SEC001", path: "agents.worker.env.BAD_SECRET.name" }),
      expect.objectContaining({ code: "E004", path: "root.nodes.bad_assert.condition" }),
      expect.objectContaining({ code: "TM002", path: "root.nodes.bad_assert.message.parts.0.value" }),
      expect.objectContaining({ code: "E000", path: "root.nodes.bad_assert.message.parts.1.expr" }),
      expect.objectContaining({ code: "TM002", path: "root.nodes.bad_assert.message.parts.2.kind" }),
      expect.objectContaining({ code: "TM001", path: "root.nodes.bad_signal.run.prompt" }),
      expect.objectContaining({ code: "E000", path: "root.nodes.bad_fanout.over" }),
    ]));
  });

  it("rejects unknown task run fields in serialized IR", () => {
    const ir = minimalWorkflow({
      root: {
        nodes: [{
          id: "run_task",
          kind: "task",
          run: {
            kind: "task_run",
            input: {},
            target: { kind: "inline", runtime: "node", source: "async function task() {}" },
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
        nodes: [{
          id: "run_task",
          kind: "task",
          run: {
            kind: "task_run",
            input: {},
            target: {
              kind: "module",
              runtime: "node",
              specifier: "",
              exportName: "",
              referrer: { kind: "workflow", path: "../workflow.ts" },
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
      irVersion: 2,
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
      root: { nodes: [] },
      outputs: {},
      lock: { acpusCoreVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
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
      irVersion: 2,
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
      root: { nodes: [] },
      outputs: {},
      lock: { acpusCoreVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
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
      irVersion: 2,
      name: "valid_recursive_schema",
      inputSchema: {
        kind: "object",
        fields: {
          file: { kind: "string" },
          home: { kind: "path" },
          tags: { kind: "array", item: { kind: "string" } },
          config: { kind: "record", value: { kind: "union", variants: [{ kind: "string" }, { kind: "number" }, { kind: "null" }] } },
        },
        required: ["file", "home"],
        additionalProperties: false,
      },
      agents: {},
      root: { nodes: [] },
      outputs: {},
      lock: { acpusCoreVersion: "test", generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual([]);
  });

  it("validates top-level workflow outputs", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      outputs: {
        bad: { kind: "ref", path: [] },
      },
    }));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "E001",
      path: "outputs.bad.path",
    }));
  });

  it("rejects self, later sibling, and missing node refs", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
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

  it("rejects top-level outputs that reference node internals", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [taskNode("first")],
      },
      outputs: {
        bad: { kind: "ref", path: ["nodes", "first", "run", "target"] },
      },
    }));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "IR003",
      path: "outputs.bad.path",
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
              outputs: {
                child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
              },
            },
            else: { nodes: [], outputs: {} },
          },
          taskNode("bad_child_internal", {
            child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
          }),
        ],
      },
      outputs: {
        child: { kind: "ref", path: ["nodes", "child", "output", "id"] },
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_child_internal.run.input.child.path" }),
      expect.objectContaining({ code: "IR003", path: "outputs.child.path" }),
    ]));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "IR003",
      path: "root.nodes.gate.then.nodes.child.run.input.parent.path",
    }));
  });

  it("rejects sibling parallel branch and switch case node refs", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          {
            id: "branches",
            kind: "parallel",
            strategy: "all",
            branches: {
              left: {
                scope: {
                  nodes: [taskNode("left_task")],
                  outputs: { value: { kind: "ref", path: ["nodes", "left_task", "output", "value"] } },
                },
              },
              right: {
                scope: {
                  nodes: [],
                  outputs: { value: { kind: "ref", path: ["nodes", "left_task", "output", "value"] } },
                },
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
                  outputs: { value: { kind: "ref", path: ["nodes", "case_task", "output", "value"] } },
                },
              },
              {
                when: { kind: "literal", value: false },
                then: {
                  nodes: [],
                  outputs: { value: { kind: "ref", path: ["nodes", "case_task", "output", "value"] } },
                },
              },
            ],
            default: { nodes: [], outputs: {} },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.branches.branches.right.scope.outputs.value.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.route.cases.1.then.outputs.value.path" }),
    ]));
  });

  it("rejects fanout and loop local refs outside their owning scope", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: {
              nodes: [],
              outputs: {
                missing: { kind: "ref", path: ["nodes", "missing", "output", "id"] },
              },
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
              outputs: {
                state: { kind: "ref", path: ["loop", "other", "state"] },
                stop: { kind: "ref", path: ["loop", "retry", "state", "done"] },
              },
            },
          },
          taskNode("bad_loop_local", {
            state: { kind: "ref", path: ["loop", "retry", "state", "id"] },
          }),
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.items.do.outputs.missing.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_fanout_local.run.input.item.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.retry.do.outputs.state.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.bad_loop_local.run.input.state.path" }),
    ]));
  });

  it("rejects unsupported fanout and loop local ref members", () => {
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            key: { kind: "template", parts: [{ kind: "expr", expr: { kind: "ref", path: ["fanout", "items", "output"] } }] },
            do: {
              nodes: [],
              outputs: {
                bad: { kind: "ref", path: ["fanout", "items", "output"] },
              },
            },
          },
          {
            id: "retry",
            kind: "loop",
            state: { kind: "object", fields: {} },
            do: {
              nodes: [],
              outputs: {
                state: { kind: "object", fields: {} },
                stop: { kind: "ref", path: ["loop", "retry", "item"] },
              },
            },
          },
        ],
      },
    } as any));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR003", path: "root.nodes.items.key.parts.0.expr.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.items.do.outputs.bad.path" }),
      expect.objectContaining({ code: "IR003", path: "root.nodes.retry.do.outputs.stop.path" }),
    ]));
  });

  it("returns diagnostics instead of throwing for malformed top-level containers", () => {
    const malformed = {
      irVersion: 1,
      name: "malformed",
      agents: [],
      root: "bad",
      outputs: [],
      lock: { notes: "bad" },
      diagnostics: {},
    };

    expect(() => validateWorkflowIR(malformed as any)).not.toThrow();
    expect(validateWorkflowIR(malformed as any)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR002", path: "irVersion" }),
      expect.objectContaining({ code: "IR002", path: "agents" }),
      expect.objectContaining({ code: "E004", path: "outputs" }),
      expect.objectContaining({ code: "IR002", path: "lock.acpusCoreVersion" }),
      expect.objectContaining({ code: "IR002", path: "lock.generatedAt" }),
      expect.objectContaining({ code: "IR002", path: "lock.notes" }),
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
        nodes: [{
          id: "review",
          kind: "agent",
          run: {
            kind: "agent_run",
            agent: "reviewer",
            prompt: { kind: "template", parts },
          },
        }],
      },
    } as any))).toContainEqual(expect.objectContaining({
      code: "TM002",
      path: "root.nodes.review.run.prompt.parts.0",
    }));
  });
});
