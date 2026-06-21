import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { WORKFLOW_SCHEMA } from "../../src/workflow-schema.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("Schema validation: unknown fields", () => {
  it("has diagnostic branch inference coverage for every current step schema branch", () => {
    const cases = [
      {
        branch: "agentStep",
        step: `id: s
      run: agent
      use: mock
      prompt: "x"
      extra: true`
      },
      {
        branch: "programStep",
        step: `id: s
      run: program
      cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "signalStep",
        step: `id: s
      run: signal
      prompt: "OK?"
      extra: true`
      },
      {
        branch: "pipelineStep",
        step: `id: s
      pipeline:
        - id: child
          run: program
          cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "parallelStep",
        step: `id: s
      parallel:
        - id: left
          do:
            - id: child
              run: program
              cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "fanoutStep",
        step: `id: s
      fanout:
        over: [1]
        do:
          - id: child
            run: program
            cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "switchStep",
        step: `id: s
      switch:
        cases:
          - when: "true"
            do:
              - id: child
                run: program
                cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "loopStep",
        step: `id: s
      loop:
        max_iterations: 1
        do:
          - id: child
            run: program
            cmd: ["echo", "x"]
      extra: true`
      },
      {
        branch: "guardStep",
        step: `id: s
      guard:
        when: "true"
        then: continue
        else: fail
      extra: true`
      },
      {
        branch: "subworkflowStep",
        step: `id: s
      subworkflow: ./child.yaml
      extra: true`
      }
    ];

    const schemaBranches = ((WORKFLOW_SCHEMA.$defs as Record<string, unknown>).step as { oneOf: Array<{ $ref: string }> }).oneOf
      .map((entry) => entry.$ref.replace("#/$defs/", ""))
      .sort();
    expect(cases.map((item) => item.branch).sort()).toEqual(schemaBranches);

    for (const item of cases) {
      const result = lintWorkflow(`
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - ${item.step}
`);
      expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0]", message: "Unknown step property 'extra'" });
      expect(result.diagnostics.some((d) => d.code === "STEP_KIND")).toBe(false);
    }
  });

  it("rejects unknown top-level property", () => {
    const src = `
version: 1
name: test
unknown_top: true
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", message: "Unknown" });
  });

  it("rejects unknown agent property", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: command, use: "echo", modle: gpt-5 }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE", message: "Unknown" });
  });

  it("rejects stale agent permission and concurrency fields", () => {
    const src = `
version: 1
name: test
agents:
  coder:
    type: command
    use: "echo"
    tools_allowlist: ["shell"]
    max_concurrency: 1
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE", message: "Unknown" });
  });

  it("rejects unknown step property on agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      cmdd: "echo"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown step property on program step", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      defaults: { x: 1 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0]", message: "Unknown" });
  });

  it("rejects unknown capture property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stdout, parse: text, encoding: utf8 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_SHAPE", message: "Unknown" });
  });

  it("rejects unknown fanout property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        batch_size: 5
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown signal node property", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: gate
      run: signal
      prompt: "OK?"
      timeout: 5m
      on_timeout: fail
      notify: admin@example.com
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown guard property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
        severity: high
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown retry property", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 3, max_attempts: 2 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE", message: "Unknown" });
  });

  it("rejects unknown workflow property", () => {
    const src = `
version: 1
name: test
workflow:
  timeout: 10m
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", message: "Unknown" });
  });

  it("rejects unknown step property nested in loop.do", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: outer
      loop:
        max_iterations: 3
        do:
          - id: inner
            run: agent
            use: mock
            prompt: "x"
            bogus_field: 1
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0].loop.do[0]", message: "Unknown step property 'bogus_field'" });
  });

  it("rejects unknown step property nested in a parallel branch", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: outer
      parallel:
        - id: inner
          do:
            - id: inner_step
              run: program
              cmd: ["echo", "hi"]
              surprise: true
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0].parallel[0].do[0]", message: "Unknown step property 'surprise'" });
  });

  it("reports direct parallel steps as missing branch do", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: outer
      parallel:
        - id: old_style_step
          run: program
          cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "PARALLEL_DO", path: "$.workflow.steps[0].parallel[0]", message: "branch descriptors { id, do }" });
  });

  it("reports a missing required field on a nested step without ancestor cascade", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: outer
      loop:
        max_iterations: 3
        do:
          - id: inner
            run: agent
            use: mock
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_PROMPT", path: "$.workflow.steps[0].loop.do[0]" });
    // The enclosing loop is well-formed; it MUST NOT be reported as a bad step.
    const outerErrors = result.diagnostics.filter((d) => d.path === "$.workflow.steps[0]");
    expect(outerErrors).toHaveLength(0);
  });

  it("rejects unknown step property nested in a switch case do list", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: router
      switch:
        cases:
          - when: input.kind == "a"
            do:
              - id: handle
                run: agent
                use: mock
                prompt: "x"
                surprise: true
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0].switch.cases[0].do[0]", message: "Unknown step property 'surprise'" });
  });

  it("accepts step-level cwd on agent and program steps", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: "x"
      cwd: "\${{ input.path }}"
    - id: p
      run: program
      cmd: ["echo", "hi"]
      cwd: "/tmp"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts policy: read on agent definition", () => {
    const src = `
version: 1
name: test
agents:
  reviewer: { type: command, use: "echo stub", policy: read }
workflow:
  steps:
    - id: a
      run: agent
      use: reviewer
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts policy: full on agent definition", () => {
    const src = `
version: 1
name: test
agents:
  worker: { type: command, use: "echo stub", policy: full }
workflow:
  steps:
    - id: a
      run: agent
      use: worker
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts policy: read on agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: "x"
      policy: read
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts policy: full on agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: "x"
      policy: full
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid policy value on agent definition", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: command, use: "echo stub", policy: write }
workflow:
  steps:
    - id: a
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", path: "$.agents.coder.policy" });
  });

  it("rejects invalid policy value on agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: "x"
      policy: admin
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", path: "$.workflow.steps[0].policy" });
  });

  it("accepts policy on a builtin agent definition", () => {
    const src = `
version: 1
name: test
agents:
  reviewer: { use: pi, policy: read }
workflow:
  steps:
    - id: a
      run: agent
      use: reviewer
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("rejects policy on a program step", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: p
      run: program
      cmd: ["echo", "hi"]
      policy: read
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE" });
  });

  it("rejects a non-string cwd on an agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: "x"
      cwd: 123
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", path: "$.workflow.steps[0].cwd" });
  });
});
