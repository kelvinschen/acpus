import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow, lintWorkflow } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/core compiler", () => {
  // ── Canonical spec compilation (M1 Test Plan) ──

  it("compiles Case A: plan-review-impl (sequential + approval + agents)", () => {
    const result = compileWorkflow(fixture("case-a-plan-review-impl.yaml"), {
      sourcePath: join(fixtures, "case-a-plan-review-impl.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("plan-review-impl");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.agent",
      "approval",
      "run.agent",
      "run.program"
    ]);
    expect(result.schedule?.nodes).toHaveLength(4);
  });

  it("compiles Case B: multi-agent-review (fanout + quorum + switch)", () => {
    const result = compileWorkflow(fixture("case-b-multi-agent-review.yaml"), {
      sourcePath: join(fixtures, "case-b-multi-agent-review.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("multi-agent-review");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.program",
      "fanout",
      "run.program",
      "approval",
      "switch"
    ]);
    expect(result.schedule?.nodes).toHaveLength(5);
    // Fanout lane template has 1 child (a parallel node with 3 branches)
    const fanoutNode = result.ir?.root.children?.[1];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.children?.length).toBe(1);
    const innerParallel = fanoutNode?.children?.[0];
    expect(innerParallel?.kind).toBe("parallel");
    expect(innerParallel?.children?.length).toBe(3);
  });

  it("compiles Case C: refactor-and-fix (fanout + subworkflow + loop + switch)", () => {
    const result = compileWorkflow(fixture("case-c-refactor-and-fix.yaml"), {
      sourcePath: join(fixtures, "case-c-refactor-and-fix.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("refactor-and-fix");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.program",
      "fanout",
      "loop",
      "approval"
    ]);
    expect(result.schedule?.nodes).toHaveLength(4);
    // Loop contains 3 steps: run_tests, parse_failures, fix_round (switch)
    const loopNode = result.ir?.root.children?.[2];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.children?.length).toBe(3);
  });

  it("compiles Case D: deep-research (agent + dynamic fanout + loop)", () => {
    const result = compileWorkflow(fixture("case-d-deep-research.yaml"), {
      sourcePath: join(fixtures, "case-d-deep-research.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("deep-research");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.agent",
      "fanout",
      "loop",
      "approval",
      "run.agent"
    ]);
    expect(result.schedule?.nodes).toHaveLength(5);
  });

  // ── Original all-primitives fixture ──

  it("compiles a workflow with all M1 primitives", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("all-primitives");
    expect(result.ir?.root.children?.map((node) => node.kind)).toEqual([
      "run.program",
      "run.agent",
      "parallel",
      "fanout",
      "switch",
      "loop",
      "approval",
      "subworkflow"
    ]);
    expect(result.schedule?.nodes).toHaveLength(8);
    expect(result.ir?.expressions.some((expression) => expression.source.includes("steps.discover.output.files"))).toBe(true);

    // parallel → outputMerge: "map"
    const parallelNode = result.ir?.root.children?.[2];
    expect(parallelNode?.kind).toBe("parallel");
    expect(parallelNode?.outputMerge).toBe("map");

    // fanout → outputMerge: "array"
    const fanoutNode = result.ir?.root.children?.[3];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");

    // switch → outputMerge: "selected"
    const switchNode = result.ir?.root.children?.[4];
    expect(switchNode?.kind).toBe("switch");
    expect(switchNode?.outputMerge).toBe("selected");

    // loop → outputMerge: "last"
    const loopNode = result.ir?.root.children?.[5];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.outputMerge).toBe("last");
  });

  // ── Negative tests (M1 Test Plan) ──

  it("rejects invalid YAML", () => {
    const result = lintWorkflow("version: 1\nname: [\n  broken");

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "YAML_PARSE")).toBe(true);
  });

  it("rejects invalid spec shape (missing required top-level fields)", () => {
    const result = lintWorkflow("just_a_string: true");

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "SPEC_SHAPE")).toBe(true);
  });

  it("rejects wrong DSL version", () => {
    const source = `
version: 99
name: wrong-version
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "SPEC_VERSION")).toBe(true);
  });

  it("rejects steps without an id", () => {
    const result = lintWorkflow(fixture("invalid-missing-id.yaml"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_ID")).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const result = lintWorkflow(fixture("invalid-duplicate-ids.yaml"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_ID_DUPLICATE")).toBe(true);
  });

  it("rejects include cycles", () => {
    const fixturePath = join(fixtures, "include-cycle-a.yaml");
    const result = lintWorkflow(fixture("include-cycle-a.yaml"), {
      sourcePath: fixturePath,
      includeResolver: (includePath, fromPath) => {
        // Resolve includes relative to the fixture directory
        const baseDir = fromPath ? join(fixturePath, "..") : process.cwd();
        return readFileSync(join(baseDir, includePath), "utf8");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "INCLUDE_CYCLE")).toBe(true);
  });

  it("rejects output with unsupported DSL keys (no schema escape hatch)", () => {
    const source = `
version: 1
name: invalid-schema
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        schema: { type: definitely-not-json-schema-type }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "OUTPUT_SHAPE")).toBe(true);
  });

  it("rejects output.schema key with deprecation message", () => {
    const source = `
version: 1
name: schema-deprecated
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        schema: { type: object }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    const schemaDiag = result.diagnostics.find((d) => d.path === "$.workflow.steps[0].output.schema");
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag!.message).toContain("no longer supported");
    expect(schemaDiag!.message).toContain("escape hatch");
  });

  it("rejects agent steps that reference undeclared agents", () => {
    const source = `
version: 1
name: missing-agent-ref
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: ghost
      prompt: "x"
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "AGENT_REF")).toBe(true);
  });

  it("defaults agent type to builtin and injects the resolved agent into node metadata", () => {
    const source = `
version: 1
name: agent-builtin-default
agents:
  coder: { use: pi, model: gpt-5 }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    const agent = agentNode.metadata.agent as { type?: string; use?: string; model?: string };
    expect(agent.type).toBe("builtin");
    expect(agent.use).toBe("pi");
    expect(agent.model).toBe("gpt-5");
  });

  it("accepts a command agent with a launch command", () => {
    const source = `
version: 1
name: agent-command
agents:
  custom: { type: command, use: "node ./acp-server.js" }
workflow:
  steps:
    - id: ask
      run: agent
      use: custom
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    const agentNode = result.ir!.root.children!.find((n) => n.id === "ask")!;
    expect((agentNode.metadata.agent as { type?: string }).type).toBe("command");
  });

  it("accepts a mock agent that omits use", () => {
    const source = `
version: 1
name: agent-mock-no-use
agents:
  fake: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: fake
      prompt: "x"
`;
    const result = compileWorkflow(source);

    expect(result.ok).toBe(true);
    expect((result.ir!.root.children!.find((n) => n.id === "ask")!.metadata.agent as { type?: string }).type).toBe("mock");
  });

  it("rejects a builtin/command agent missing use", () => {
    const source = `
version: 1
name: agent-missing-use
agents:
  coder: { type: builtin }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "AGENT_SHAPE")).toBe(true);
  });

  it("rejects an agent with an unknown type", () => {
    const source = `
version: 1
name: agent-bad-type
agents:
  coder: { type: bogus, use: pi }
workflow:
  steps:
    - id: ask
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "AGENT_SHAPE")).toBe(true);
  });

  it("rejects fanout without over", () => {
    const source = `
version: 1
name: missing-fanout-over
workflow:
  steps:
    - id: mapped
      fanout:
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "FANOUT_OVER")).toBe(true);
  });

  it("rejects an agent retry with a non-positive max", () => {
    const source = `
version: 1
name: bad-retry
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 0 }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "RETRY_SHAPE")).toBe(true);
  });

  it("rejects an agent retry with an invalid backoff", () => {
    const source = `
version: 1
name: bad-retry-backoff
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 2, backoff: "soon" }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "RETRY_SHAPE")).toBe(true);
  });

  it("accepts a valid agent retry policy", () => {
    const source = `
version: 1
name: good-retry
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 3, backoff: "500ms" }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(true);
  });

  it("rejects invalid fanout and parallel join values", () => {
    const source = `
version: 1
name: bad-joins
workflow:
  steps:
    - id: par
      join: diagonal
      parallel:
        - id: left
          run: program
          cmd: ["echo", "left"]
    - id: mapped
      fanout:
        over: [1, 2]
        join: diagonal
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((d) => d.code === "JOIN_VALUE")).toHaveLength(2);
  });

  it("rejects quorum fanout without a positive quorum", () => {
    const source = `
version: 1
name: missing-quorum
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2]
        join: quorum
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "FANOUT_QUORUM")).toBe(true);
  });

  it("rejects invalid fanout success criteria", () => {
    const source = `
version: 1
name: bad-success-criteria
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2]
        join: all
        success_criteria:
          min_success: 0
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "FANOUT_SUCCESS_CRITERIA")).toBe(true);
  });

  it("rejects agent output when present but not an object", () => {
    const source = `
version: 1
name: bad-agent-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output: nope
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "OUTPUT_SHAPE")).toBe(true);
  });

  it("rejects invalid program capture shapes", () => {
    const invalidCases = [
      { source: "capture: nope", code: "CAPTURE_SHAPE" },
      { source: "capture: { from: stderr, parse: text }", code: "CAPTURE_FROM" },
      { source: "capture: { from: stdout, parse: xml }", code: "CAPTURE_PARSE" },
      { source: "capture: { from: file, parse: json }", code: "CAPTURE_PATH" }
    ];

    for (const item of invalidCases) {
      const source = `
version: 1
name: bad-capture
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hi"]
      ${item.source}
`;
      const result = lintWorkflow(source);

      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((d) => d.code === item.code)).toBe(true);
    }
  });

  it("promotes warnings to errors under strict mode", () => {
    // A fanout without key produces FANOUT_KEY warning; under strict it should fail
    const source = `
version: 1
name: strict-test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2, 3]
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const lenient = lintWorkflow(source);
    const strict = lintWorkflow(source, { strict: true });

    expect(lenient.ok).toBe(true);
    expect(lenient.diagnostics.some((d) => d.code === "FANOUT_KEY" && d.severity === "warning")).toBe(true);
    expect(strict.ok).toBe(false);
  });

  // ── outputMerge tests ──

  it("parallel: outputMerge is map, branch ids preserved in children", () => {
    const source = `
version: 1
name: parallel-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: par
      parallel:
        - id: a
          run: program
          cmd: ["echo", "a"]
        - id: b
          run: program
          cmd: ["echo", "b"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const parNode = result.ir?.root.children?.[0];
    expect(parNode?.kind).toBe("parallel");
    expect(parNode?.outputMerge).toBe("map");
    expect(parNode?.children?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("fanout: outputMerge is array; multi-step lane takes last child", () => {
    const source = `
version: 1
name: fanout-multi-step
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2]
        join: all
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
          - id: step_b
            run: program
            cmd: ["echo", "b"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");
    // Two direct children in the lane template; last one (step_b) is the lane output
    expect(fanoutNode?.children?.length).toBe(2);
    expect(fanoutNode?.children?.map((c) => c.id)).toEqual(["step_a", "step_b"]);
  });

  it("switch: outputMerge is selected; branches and default preserved", () => {
    const source = `
version: 1
name: switch-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: true
            do:
              - id: go
                run: program
                cmd: ["echo", "ok"]
          - when: false
            do:
              - id: maybe
                run: program
                cmd: ["echo", "maybe"]
        default:
          do:
            - id: nope
              run: program
              cmd: ["echo", "nope"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const switchNode = result.ir?.root.children?.[0];
    expect(switchNode?.kind).toBe("switch");
    expect(switchNode?.outputMerge).toBe("selected");
    expect(switchNode?.branches?.length).toBe(3);
    expect(switchNode?.branches?.[0]?.id).toBe("case_1");
    expect(switchNode?.branches?.[1]?.id).toBe("case_2");
    expect(switchNode?.branches?.[2]?.id).toBe("default");
    // case_1 has one child (go), which is the last child → case output
    expect(switchNode?.branches?.[0]?.children?.map((c) => c.id)).toEqual(["go"]);
  });

  it("switch without default: only case branches", () => {
    const source = `
version: 1
name: switch-no-default
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: true
            do:
              - id: go
                run: program
                cmd: ["echo", "ok"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const switchNode = result.ir?.root.children?.[0];
    expect(switchNode?.outputMerge).toBe("selected");
    expect(switchNode?.branches?.length).toBe(1);
    expect(switchNode?.branches?.[0]?.id).toBe("case_1");
  });

  it("loop: outputMerge is last; multi-step body takes last child", () => {
    const source = `
version: 1
name: loop-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: fix
      loop:
        until: true
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
          - id: step_b
            run: program
            cmd: ["echo", "b"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const loopNode = result.ir?.root.children?.[0];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.outputMerge).toBe("last");
    // Two direct children; last one (step_b) is the loop body output per iteration
    expect(loopNode?.children?.length).toBe(2);
    expect(loopNode?.children?.map((c) => c.id)).toEqual(["step_a", "step_b"]);
  });

  it("subworkflow: no outputMerge field", () => {
    const source = `
version: 1
name: sub-workflow
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: child
      subworkflow: ./child.yaml
      input:
        x: 1
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const subNode = result.ir?.root.children?.[0];
    expect(subNode?.kind).toBe("subworkflow");
    expect(subNode?.outputMerge).toBeUndefined();
  });

  it("compiles fanout-nested-parallel fixture", () => {
    const result = compileWorkflow(fixture("fanout-nested-parallel.yaml"), {
      sourcePath: join(fixtures, "fanout-nested-parallel.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("fanout-nested-parallel");
    const fanoutNode = result.ir?.root.children?.[1];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");
    // The direct child of fanout is a parallel node
    const innerParallel = fanoutNode?.children?.[0];
    expect(innerParallel?.kind).toBe("parallel");
    expect(innerParallel?.outputMerge).toBe("map");
    expect(innerParallel?.children?.length).toBe(2);
    // Review agent has explicit output schema
    const reviewBranch = innerParallel?.children?.[0];
    expect(reviewBranch?.id).toBe("review");
    expect(reviewBranch?.kind).toBe("run.agent");
    expect(reviewBranch?.metadata.output).toEqual({
      type: "object",
      properties: {
        verdict: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
            },
            additionalProperties: false,
            required: ["description"],
          },
        },
      },
      additionalProperties: false,
      required: ["verdict", "issues"]
    });
    // Test branch is a program step
    const testBranch = innerParallel?.children?.[1];
    expect(testBranch?.id).toBe("test");
    expect(testBranch?.kind).toBe("run.program");
  });

  it("passes outputMerge through to schedule for all composite types", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });
    expect(result.ok).toBe(true);

    const parallelScheduleNode = result.schedule?.nodes[2];
    expect(parallelScheduleNode?.kind).toBe("parallel");
    expect(parallelScheduleNode?.outputMerge).toBe("map");

    const fanoutScheduleNode = result.schedule?.nodes[3];
    expect(fanoutScheduleNode?.kind).toBe("fanout");
    expect(fanoutScheduleNode?.outputMerge).toBe("array");

    const switchScheduleNode = result.schedule?.nodes[4];
    expect(switchScheduleNode?.kind).toBe("switch");
    expect(switchScheduleNode?.outputMerge).toBe("selected");

    const loopScheduleNode = result.schedule?.nodes[5];
    expect(loopScheduleNode?.kind).toBe("loop");
    expect(loopScheduleNode?.outputMerge).toBe("last");

    // subworkflow has no outputMerge
    const subworkflowScheduleNode = result.schedule?.nodes[7];
    expect(subworkflowScheduleNode?.kind).toBe("subworkflow");
    expect(subworkflowScheduleNode?.outputMerge).toBeUndefined();
  });

  // ── Flat-map input/output tests ──

  it("compiles agent output with flat-map shorthand", () => {
    const source = `
version: 1
name: flat-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        plan_md: string
        commit_sha?: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.kind).toBe("run.agent");
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        plan_md: { type: "string" },
        commit_sha: { type: "string" }
      },
      additionalProperties: false,
      required: ["plan_md"]
    });
  });

  it("compiles recursive agent output with arrays of objects and optional nested fields", () => {
    const source = `
version: 1
name: recursive-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        issues:
          - description: string
            severity?: string
        summary?: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              severity: { type: "string" }
            },
            additionalProperties: false,
            required: ["description"]
          }
        },
        summary: { type: "string" }
      },
      additionalProperties: false,
      required: ["issues"]
    });
  });

  it("compiles recursive agent output with nested objects and arrays of primitives", () => {
    const source = `
version: 1
name: recursive-nested-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        report:
          title: string
          tags:
            - string
          stats?:
            count: integer
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            title: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            stats: {
              type: "object",
              properties: {
                count: { type: "integer" }
              },
              additionalProperties: false,
              required: ["count"]
            }
          },
          additionalProperties: false,
          required: ["title", "tags"]
        }
      },
      additionalProperties: false,
      required: ["report"]
    });
  });

  it("allows agent steps without output", () => {
    const source = `
version: 1
name: agent-no-output
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.kind).toBe("run.agent");
    expect(askNode?.metadata.output).toBeUndefined();
  });

  it("rejects unsupported object-form schema keys in agent output", () => {
    const source = `
version: 1
name: bad-output-schema-keys
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        issues:
          type: array
          items:
            type: object
            properties:
              text: { type: string }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OUTPUT_SHAPE",
          path: "$.workflow.steps[0].output.issues.items"
        })
      ])
    );
  });

  it("stores program-step capture in metadata.capture (not metadata.output)", () => {
    const source = `
version: 1
name: program-capture
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const runNode = result.ir?.root.children?.[0];
    expect(runNode?.kind).toBe("run.program");
    expect(runNode?.metadata.capture).toEqual({ from: "stdout", parse: "json" });
    expect(runNode?.metadata.output).toBeUndefined();
  });

  it("allows program steps without capture", () => {
    const source = `
version: 1
name: program-no-capture
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const runNode = result.ir?.root.children?.[0];
    expect(runNode?.kind).toBe("run.program");
    expect(runNode?.metadata.capture).toBeUndefined();
  });

  it("preserves valid fanout success criteria", () => {
    const source = `
version: 1
name: fanout-success-criteria
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2, 3]
        join: all
        success_criteria:
          min_success: 2
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.metadata.success_criteria).toEqual({ min_success: 2 });
  });

  it("accepts quorum fanout with valid quorum", () => {
    const source = `
version: 1
name: fanout-quorum
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2, 3]
        join: quorum
        quorum: 2
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.metadata.quorum).toBe(2);
  });

  // ── M1 round-trip & fixture coverage ──

  it("IR survives JSON round-trip serialization", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.ir);
    const deserialized = JSON.parse(serialized) as typeof result.ir;
    expect(deserialized).toEqual(result.ir);
  });

  it("rejects expressions referencing unknown step ids", () => {
    const result = compileWorkflow(fixture("invalid-reference.yaml"));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "EXPR_UNKNOWN_STEP")).toBe(true);
  });

  it("IR contains source digest for reproducibility", () => {
    const result = compileWorkflow(fixture("case-a-plan-review-impl.yaml"), {
      sourcePath: join(fixtures, "case-a-plan-review-impl.yaml")
    });
    expect(result.ok).toBe(true);
    expect(result.ir?.source.digest).toBeTruthy();
    expect(typeof result.ir?.source.digest).toBe("string");
    expect(result.ir?.source.path).toBe(join(fixtures, "case-a-plan-review-impl.yaml"));
  });

  // ── Expression field coercion tests ──

  it("coerces boolean until to string", () => {
    const source = `
version: 1
name: coerce-until-bool
workflow:
  steps:
    - id: fix
      loop:
        until: true
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const loopNode = result.ir?.root.children?.[0];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.metadata.until).toBe("true");
  });

  it("rejects non-boolean non-string until", () => {
    const source = `
version: 1
name: bad-until-type
workflow:
  steps:
    - id: fix
      loop:
        until: 42
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "LOOP_UNTIL_TYPE")).toBe(true);
  });

  it("coerces boolean when to string", () => {
    const source = `
version: 1
name: coerce-when-bool
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: false
            do:
              - id: go
                run: program
                cmd: ["echo", "ok"]
        default:
          do:
            - id: nope
              run: program
              cmd: ["echo", "nope"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const switchNode = result.ir?.root.children?.[0];
    expect(switchNode?.kind).toBe("switch");
    expect(switchNode?.branches?.[0]?.when).toBe("false");
  });

  it("rejects non-boolean non-string when", () => {
    const source = `
version: 1
name: bad-when-type
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: null
            do:
              - id: go
                run: program
                cmd: ["echo", "ok"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "SWITCH_WHEN_TYPE")).toBe(true);
  });

  it("coerces array over to JSON string", () => {
    const source = `
version: 1
name: coerce-over-array
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2, 3]
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.metadata.over).toBe("[1,2,3]");
  });

  it("rejects non-array non-string over", () => {
    const source = `
version: 1
name: bad-over-type
workflow:
  steps:
    - id: mapped
      fanout:
        over: 42
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "FANOUT_OVER_TYPE")).toBe(true);
  });

  // ── Step timeout and on_error validation tests ──

  it("rejects string timeout that is not a valid duration", () => {
    const source = `
version: 1
name: bad-timeout
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      timeout: "not-a-duration"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_TIMEOUT")).toBe(true);
  });

  it("accepts numeric timeout (milliseconds)", () => {
    const source = `
version: 1
name: numeric-timeout
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      timeout: 300
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.timeout).toBe(300);
  });

  it("rejects invalid on_error value", () => {
    const source = `
version: 1
name: bad-on-error
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      on_error: explode
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_ON_ERROR")).toBe(true);
  });

  it("accepts valid on_error value", () => {
    const source = `
version: 1
name: good-on-error
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      on_error: fail
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.on_error).toBe("fail");
  });

  it("rejects approval timeout with invalid duration format", () => {
    const source = `
version: 1
name: bad-approval-timeout
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "Approve?"
        timeout: "2d"
        on_timeout: reject
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "APPROVAL_TIMEOUT")).toBe(true);
  });

  it("accepts program step timeout and on_error", () => {
    const source = `
version: 1
name: program-timeout-onerror
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      timeout: "5m"
      on_error: retry
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const runNode = result.ir?.root.children?.[0];
    expect(runNode?.metadata.timeout).toBe("5m");
    expect(runNode?.metadata.on_error).toBe("retry");
  });

  it("rejects fanout over array containing objects (not valid CEL)", () => {
    const source = `
version: 1
name: over-with-objects
workflow:
  steps:
    - id: mapped
      fanout:
        over:
          - key: val
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "FANOUT_OVER_TYPE")).toBe(true);
  });

  it("rejects negative numeric timeout", () => {
    const source = `
version: 1
name: negative-timeout
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      timeout: -500
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_TIMEOUT")).toBe(true);
  });

  it("rejects non-string on_error with clear type message", () => {
    const source = `
version: 1
name: on-error-null
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      on_error: null
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "STEP_ON_ERROR")).toBe(true);
    const diag = result.diagnostics.find((d) => d.code === "STEP_ON_ERROR")!;
    expect(diag.message).toContain("null");
  });

  it("reports 'got null' instead of 'got object' for null when/until", () => {
    const sourceUntil = `
version: 1
name: until-null
workflow:
  steps:
    - id: fix
      loop:
        until: null
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
`;
    const result = lintWorkflow(sourceUntil);
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => d.code === "LOOP_UNTIL_TYPE")!;
    expect(diag.message).toContain("got null");
    expect(diag.message).not.toContain("got object");
  });

  // ── Program output schema tests ──

  it("compiles program step output schema into metadata.output", () => {
    const source = `
version: 1
name: program-output
workflow:
  steps:
    - id: parse_result
      run: program
      cmd: ["echo", '{"count": 5}']
      capture: { from: stdout, parse: json }
      output:
        count: integer
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const node = result.ir?.root.children?.[0];
    expect(node?.kind).toBe("run.program");
    expect(node?.metadata.output).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      additionalProperties: false,
      required: ["count"]
    });
  });

  it("allows program step without output", () => {
    const source = `
version: 1
name: program-no-output
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    expect(result.ir?.root.children?.[0]?.metadata.output).toBeUndefined();
  });

  it("rejects program step output when not an object", () => {
    const source = `
version: 1
name: program-bad-output
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
      output: nope
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "OUTPUT_SHAPE" && d.path === "$.workflow.steps[0].output")).toBe(true);
  });

  it("accepts program output with capture.parse: json", () => {
    const source = `
version: 1
name: program-output-json
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", '{"status": "ok"}']
      capture: { from: stdout, parse: json }
      output:
        status: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
  });

  it("rejects program output with capture.parse: text", () => {
    const source = `
version: 1
name: program-output-text
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: text }
      output:
        status: string
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "OUTPUT_REQUIRES_JSON")).toBe(true);
  });

  it("rejects program output without capture", () => {
    const source = `
version: 1
name: program-output-no-capture
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      output:
        status: string
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "OUTPUT_REQUIRES_JSON")).toBe(true);
  });

  it("rejects program output with schema escape hatch key", () => {
    const source = `
version: 1
name: program-output-schema-key
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
      output:
        schema: { type: object }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    const schemaDiag = result.diagnostics.find((d) => d.path === "$.workflow.steps[0].output.schema");
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag!.message).toContain("no longer supported");
    expect(schemaDiag!.message).toContain("escape hatch");
  });
});
