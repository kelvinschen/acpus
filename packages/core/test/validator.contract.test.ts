import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type WorkflowIR } from "../src/ir.js";

function minimalWorkflow(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    irVersion: 2,
    name: "minimal",
    agents: {},
    root: { nodes: [] },
    outputs: {},
    assets: { taskBundles: {} },
    lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
    diagnostics: [],
    ...overrides,
  };
}

describe("WorkflowIR diagnostics contract", () => {
  it("accepts expression lambda IR through the workflow validator", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "lambda_expression",
      agents: {},
      root: {
        nodes: [],
        outputs: {
          scores: {
            kind: "call",
            fn: "map",
            args: [
              { kind: "ref", path: ["input", "items"] },
              {
                kind: "lambda",
                params: [{ id: "v0" }, { id: "v1" }],
                body: { kind: "var", id: "v0", path: ["score"] },
              },
            ],
          },
        },
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
      path: "inputSchema.required.0",
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

  it("rejects fields outside the closed IR shape", () => {
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
            run: { kind: "task_run", input: {}, bundleId: "missing", exportName: "default", digest: "sha256:x", runtime: "node" },
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
          outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
          run: {
            kind: "task_run",
            input: {},
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

  it("rejects scope output fields outside the declared outputSchema across composites", () => {
    const objectSchema = (fields: string[]) => ({
      kind: "object" as const,
      fields: Object.fromEntries(fields.map(name => [name, { kind: "string" as const }])),
      required: [],
      additionalProperties: false,
    });
    const ok = { kind: "literal" as const, value: "ok" };
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "excess_outputs",
      agents: {},
      root: {
        nodes: [
          {
            id: "gate",
            kind: "if",
            condition: { kind: "literal", value: true },
            outputSchema: objectSchema(["status"]),
            then: { nodes: [], outputs: { status: ok, extra_then: ok } },
            else: { nodes: [], outputs: { status: ok, extra_else: ok } },
          },
          {
            id: "route",
            kind: "switch",
            outputSchema: objectSchema(["code"]),
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: { code: ok, extra_case: ok } } }],
            default: { nodes: [], outputs: { code: ok, extra_default: ok } },
          },
          {
            id: "checks",
            kind: "parallel",
            strategy: "all",
            branches: {
              left: { outputSchema: objectSchema(["ready"]), scope: { nodes: [], outputs: { ready: ok, extra_branch: ok } } },
            },
          },
          {
            id: "items",
            kind: "fanout",
            strategy: "all",
            over: { kind: "array", items: [] },
            itemOutputSchema: objectSchema(["label"]),
            do: { nodes: [], outputs: { label: ok, extra_item: ok } },
          },
          {
            id: "retry",
            kind: "loop",
            maxIterations: 1,
            outputSchema: objectSchema(["done"]),
            do: { nodes: [], outputs: { done: ok, extra_loop: ok } },
            stopWhen: { kind: "literal", value: true },
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
      diagnostics: [],
    } as any;

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "O001", path: "root.nodes.gate.then.outputs.extra_then" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.gate.else.outputs.extra_else" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.route.cases.0.then.outputs.extra_case" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.route.default.outputs.extra_default" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.checks.branches.left.scope.outputs.extra_branch" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.items.do.outputs.extra_item" }),
      expect.objectContaining({ code: "O001", path: "root.nodes.retry.do.outputs.extra_loop" }),
    ]));
    // Declared fields must not be flagged.
    expect(diagnostics.filter(d => d.code === "O001")).toHaveLength(7);
  });

  it("allows scope output fields outside the schema when no schema or additionalProperties is open", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "excess_allowed",
      agents: {},
      root: {
        nodes: [
          {
            id: "schemaless_if",
            kind: "if",
            condition: { kind: "literal", value: true },
            then: { nodes: [], outputs: { anything: { kind: "literal", value: "ok" } } },
          },
          {
            id: "open_loop",
            kind: "loop",
            maxIterations: 1,
            outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: true },
            do: { nodes: [], outputs: { open_extra: { kind: "literal", value: "ok" } } },
            stopWhen: { kind: "literal", value: true },
          },
        ],
      },
      outputs: {},
      assets: { taskBundles: {} },
      lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
      diagnostics: [],
    } as any;

    expect(validateWorkflowIR(ir).filter(d => d.code === "O001")).toHaveLength(0);
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
      assets: { taskBundles: {} },
      lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
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

  it("validates literal, enum, artifact, and secret schema variants", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "bad_schema_variants",
      inputSchema: {
        kind: "union",
        variants: [
          { kind: "literal", value: {} },
          { kind: "enum", values: ["ok", {}] },
          { kind: "artifact", mediaType: 1 },
          { kind: "secret_ref", extra: true },
        ],
      } as any,
      agents: {},
      root: { nodes: [] },
      outputs: {},
      assets: { taskBundles: {} },
      lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
      diagnostics: [],
    };

    expect(validateWorkflowIR(ir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.0.value" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.1.values.1" }),
      expect.objectContaining({ code: "SC002", path: "inputSchema.variants.2.mediaType" }),
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
          file: { kind: "artifact", mediaType: "text/plain" },
          home: { kind: "path" },
          secret: { kind: "secret_ref" },
          tags: { kind: "array", item: { kind: "string" } },
          config: { kind: "record", value: { kind: "union", variants: [{ kind: "string" }, { kind: "number" }, { kind: "null" }] } },
        },
        required: ["file", "home"],
        additionalProperties: false,
      },
      agents: {},
      root: { nodes: [] },
      outputs: {},
      assets: { taskBundles: {} },
      lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
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

  it("returns diagnostics instead of throwing for malformed top-level containers", () => {
    const malformed = {
      irVersion: 1,
      name: "malformed",
      agents: [],
      root: "bad",
      outputs: [],
      assets: {},
      lock: { notes: "bad" },
      diagnostics: {},
    };

    expect(() => validateWorkflowIR(malformed as any)).not.toThrow();
    expect(validateWorkflowIR(malformed as any)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "IR002", path: "irVersion" }),
      expect.objectContaining({ code: "IR002", path: "agents" }),
      expect.objectContaining({ code: "E004", path: "outputs" }),
      expect.objectContaining({ code: "IR002", path: "assets.taskBundles" }),
      expect.objectContaining({ code: "IR002", path: "lock.acpusCoreVersion" }),
      expect.objectContaining({ code: "IR002", path: "lock.taskBundleDigests" }),
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
