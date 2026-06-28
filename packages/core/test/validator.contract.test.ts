import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type WorkflowIR } from "../src/index.js";

describe("WorkflowIR diagnostics contract", () => {
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
      assets: {
        taskBundles: {
          wrong_key: {
            id: "actual_id",
            digest: "not-sha",
            runtime: "node",
          },
        },
      },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
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
      "T004",
      "T005",
      "T006",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A001",
      path: "root.nodes.review.run.agent",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "SC001",
      path: "inputSchema",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "T005",
      path: "assets.taskBundles.wrong_key.digest",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "T006",
      path: "assets.taskBundles.wrong_key.source",
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
            itemOutputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
            do: { nodes: [], outputs: {} },
          } as any,
          {
            id: "missing_count",
            kind: "fanout",
            strategy: "quorum",
            over: { kind: "array", items: [] },
            itemOutputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
            do: { nodes: [], outputs: {} },
          } as any,
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
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
        bad_kind: {
          kind: "agent_builtin",
          use: "codex",
        },
      } as any,
      root: { nodes: [] },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "A002",
      "IR001",
      "A002",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.missing_use.use",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "IR001",
      path: "agents.command_with_model.model",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A002",
      path: "agents.bad_kind",
    }));
  });

  it("validates signal timeout and loop exhaustion strategy invariants", () => {
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
            onTimeout: { action: "retry" },
          } as any,
          {
            id: "bad_exhausted",
            kind: "loop",
            maxIterations: 1,
            do: { nodes: [], outputs: {} },
            stopWhen: { kind: "literal", value: false },
            outputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
            onExhausted: "continue",
          } as any,
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["S001", "L002"]);
  });

  it("validates required aligned IR fields", () => {
    const outputSchema = {
      kind: "object" as const,
      fields: {},
      required: [],
      additionalProperties: false,
    };
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
            outputSchema,
          },
          {
            id: "switch_without_default",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: {} } }],
            outputSchema,
          },
          {
            id: "loop_without_output_schema",
            kind: "loop",
            maxIterations: 1,
            do: { nodes: [], outputs: {} },
            stopWhen: { kind: "literal", value: true },
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
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
      "SC000",
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

  it("rejects unspecified IR fields instead of tolerating old aliases", () => {
    const outputSchema = {
      kind: "object" as const,
      fields: {},
      required: [],
      additionalProperties: false,
    };
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "closed_shape",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: {
        nodes: [
          {
            id: "review",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", use: "reviewer", prompt: { kind: "template", parts: [] } },
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
            itemOutputSchema: outputSchema,
            outputSchema,
          },
          {
            id: "retry",
            kind: "loop",
            maxIterations: 1,
            do: { nodes: [], outputs: {} },
            stopWhen: { kind: "literal", value: true },
            until: { kind: "literal", value: true },
            outputSchema,
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR001", path: "root.nodes.review.run.use" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.assert_ready.that" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.gate.when" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.gate.otherwise" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.route.otherwise" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.items.outputSchema" }),
      expect.objectContaining({ code: "IR001", path: "root.nodes.retry.until" }),
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
            itemOutputSchema: {
              kind: "object",
              fields: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
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

  it("requires schemas declared as required by IR types", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "missing_required_schemas",
      agents: {},
      root: {
        nodes: [
          {
            id: "task_without_schema",
            kind: "task",
            inputs: {},
            run: { kind: "task_run", bundleId: "missing", exportName: "default", digest: "sha256:x", runtime: "node" },
          },
          {
            id: "signal_without_schema",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
          },
          {
            id: "parallel_without_branch_schema",
            kind: "parallel",
            strategy: "all",
            branches: { branch: { scope: { nodes: [], outputs: {} } } },
          },
          {
            id: "fanout_without_item_schema",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            do: { nodes: [], outputs: {} },
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC000", path: "root.nodes.task_without_schema.outputSchema" }),
      expect.objectContaining({ code: "SC000", path: "root.nodes.signal_without_schema.outputSchema" }),
      expect.objectContaining({ code: "SC000", path: "root.nodes.parallel_without_branch_schema.branches.branch.outputSchema" }),
      expect.objectContaining({ code: "SC000", path: "root.nodes.fanout_without_item_schema.itemOutputSchema" }),
    ]));
  });

  it("requires task run digest to match the bundled task digest", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "task_digest_mismatch",
      agents: {},
      root: {
        nodes: [{
          id: "run_task",
          kind: "task",
          inputs: {},
          outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
          run: {
            kind: "task_run",
            bundleId: "task_a",
            exportName: "default",
            digest: "sha256:wrong",
            runtime: "node",
          },
        }],
      },
      outputs: {},
      assets: {
        taskBundles: {
          task_a: {
            id: "task_a",
            digest: "sha256:correct",
            runtime: "node",
            source: "export default async function task() {}\n",
          },
        },
      },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: { task_a: "sha256:correct" },
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toContainEqual(expect.objectContaining({
      code: "T008",
      path: "root.nodes.run_task.run.digest",
    }));
  });
});
