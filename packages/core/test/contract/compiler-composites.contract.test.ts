import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow, lintWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";
import type { IrNode } from "../../src/types.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

function collectIds(node: IrNode): string[] {
  return [
    node.id,
    ...(node.children ?? []).flatMap(collectIds),
    ...(node.branches ?? []).flatMap((branch) => collectIds(branch.child))
  ];
}

function collectNodePaths(node: IrNode): string[] {
  return [
    node.nodePath.join("/"),
    ...(node.children ?? []).flatMap(collectNodePaths),
    ...(node.branches ?? []).flatMap((branch) => collectNodePaths(branch.child))
  ];
}

describe("@acpus/core compiler: composites (outputMerge, IR shape)", () => {
  it("parallel: outputMerge is map, branch ids preserved in children", () => {
    const source = `
version: 1
name: parallel-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: par
      parallel:
        - id: a
          do:
            - id: step_a
              run: program
              cmd: ["echo", "a"]
        - id: b
          do:
            - id: step_b
              run: program
              cmd: ["echo", "b"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const parNode = result.ir?.root.children?.[0];
    expect(parNode?.kind).toBe("parallel");
    expect(parNode?.outputMerge).toBe("map");
    expect(parNode?.branches?.map((b) => b.id)).toEqual(["a", "b"]);
    expect(parNode?.branches?.[0]?.child.children?.map((c) => c.id)).toEqual(["step_a"]);
  });

  it("generated do pipeline ids are parent-local and nodePaths stay unique", () => {
    const source = `
version: 1
name: generated-ids
workflow:
  steps:
    - id: route_a
      switch:
        cases:
          - when: true
            do:
              - id: a
                run: program
                cmd: ["echo", "a"]
        default:
          do:
            - id: a_default
              run: program
              cmd: ["echo", "a"]
    - id: route_b
      switch:
        cases:
          - when: false
            do:
              - id: b
                run: program
                cmd: ["echo", "b"]
        default:
          do:
            - id: b_default
              run: program
              cmd: ["echo", "b"]
    - id: par_a
      parallel:
        - id: same
          do:
            - id: pa
              run: program
              cmd: ["echo", "pa"]
    - id: par_b
      parallel:
        - id: same
          do:
            - id: pb
              run: program
              cmd: ["echo", "pb"]
`;
    const first = compileWorkflow(source);
    const second = compileWorkflow(source);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const ids = collectIds(first.ir!.root).filter((id) => id.startsWith("$"));
    expect(ids).toEqual(["$case_1", "$default", "$case_1", "$default", "$same", "$same"]);
    expect(ids).toEqual(collectIds(second.ir!.root).filter((id) => id.startsWith("$")));

    const nodePaths = collectNodePaths(first.ir!.root);
    expect(nodePaths).toHaveLength(new Set(nodePaths).size);
    expect(nodePaths).toContain("workflow/route_a/$case_1");
    expect(nodePaths).toContain("workflow/route_b/$case_1");
    expect(nodePaths).toContain("workflow/par_a/$same");
    expect(nodePaths).toContain("workflow/par_b/$same");
  });

  it("uses short generated ids for fanout and loop bodies", () => {
    const source = `
version: 1
name: generated-do
workflow:
  steps:
    - id: mapped_a
      fanout:
        over: [a]
        do:
          - id: work_a
            run: program
            cmd: ["echo", "a"]
    - id: mapped_b
      fanout:
        over: [b]
        do:
          - id: work_b
            run: program
            cmd: ["echo", "b"]
    - id: iter
      loop:
        max_iterations: 1
        do:
          - id: work_c
            run: program
            cmd: ["echo", "c"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const ids = collectIds(result.ir!.root).filter((id) => id.startsWith("$"));
    expect(ids).toEqual(["$do", "$do", "$do"]);
    expect(collectNodePaths(result.ir!.root)).toEqual(expect.arrayContaining([
      "workflow/mapped_a/$do",
      "workflow/mapped_b/$do",
      "workflow/iter/$do"
    ]));
  });

  it("fanout: outputMerge is array; multi-step lane takes last child", () => {
    const source = `
version: 1
name: fanout-multi-step
agents:
  mock: { type: command, use: "echo stub" }
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
    expect(fanoutNode?.children?.[0]?.kind).toBe("pipeline");
    expect(fanoutNode?.children?.[0]?.children?.map((c) => c.id)).toEqual(["step_a", "step_b"]);
  });

  it("switch: outputMerge is selected; branches and default preserved", () => {
    const source = `
version: 1
name: switch-output
agents:
  mock: { type: command, use: "echo stub" }
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
    expect(switchNode?.branches?.[0]?.child.children?.map((c) => c.id)).toEqual(["go"]);
  });

  it("rejects switch without default", () => {
    const source = `
version: 1
name: switch-no-default
agents:
  mock: { type: command, use: "echo stub" }
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
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, {
      code: "SPEC_SHAPE",
      path: "$.workflow.steps[0].switch",
      message: "Missing required property 'default'"
    });
  });

  it("if: outputMerge is selected; then and else compile as generated pipelines", () => {
    const source = `
version: 1
name: if-output
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
        else:
          - id: disabled
            run: program
            cmd: ["echo", "disabled"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const ifNode = result.ir?.root.children?.[0];
    expect(ifNode?.kind).toBe("if");
    expect(ifNode?.outputMerge).toBe("selected");
    expect(ifNode?.branches?.map((b) => b.id)).toEqual(["then", "else"]);
    expect(ifNode?.branches?.[0]?.when).toBe("input.enabled");
    expect(collectIds(ifNode!)).toEqual(["maybe", "$then", "enabled", "$else", "disabled"]);
    expect(collectNodePaths(ifNode!)).toEqual([
      "workflow/maybe",
      "workflow/maybe/$then",
      "workflow/maybe/$then/enabled",
      "workflow/maybe/$else",
      "workflow/maybe/$else/disabled"
    ]);
  });

  it("if: omits the else branch when else is not declared", () => {
    const source = `
version: 1
name: if-no-else
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const ifNode = result.ir?.root.children?.[0];
    expect(ifNode?.kind).toBe("if");
    expect(ifNode?.branches?.map((b) => b.id)).toEqual(["then"]);
  });

  it("coerces if boolean condition to string", () => {
    const source = `
version: 1
name: if-bool-condition
workflow:
  steps:
    - id: maybe
      if:
        condition: false
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const ifNode = result.ir?.root.children?.[0];
    expect(ifNode?.kind).toBe("if");
    expect(ifNode?.branches?.[0]?.when).toBe("false");
  });

  it("rejects invalid if shapes", () => {
    const missingCondition = lintWorkflow(`
version: 1
name: if-missing-condition
workflow:
  steps:
    - id: maybe
      if:
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
`);
    expect(missingCondition.ok).toBe(false);
    expectDiagnostic(missingCondition, { code: "STEP_SHAPE", path: "$.workflow.steps[0].if", message: "if.condition is required" });

    const missingThen = lintWorkflow(`
version: 1
name: if-missing-then
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
`);
    expect(missingThen.ok).toBe(false);
    expectDiagnostic(missingThen, { code: "STEP_SHAPE", path: "$.workflow.steps[0].if", message: "if.then" });

    const emptyThen = lintWorkflow(`
version: 1
name: if-empty-then
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then: []
`);
    expect(emptyThen.ok).toBe(false);
    expectDiagnostic(emptyThen, { code: "STEP_SHAPE", path: "$.workflow.steps[0].if.then", message: "if.then must be a non-empty array of steps" });

    const invalidThen = lintWorkflow(`
version: 1
name: if-invalid-then
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then: 42
`);
    expect(invalidThen.ok).toBe(false);
    expectDiagnostic(invalidThen, { code: "STEP_SHAPE", path: "$.workflow.steps[0].if.then", message: "if.then must be a non-empty array of steps" });

    const emptyElse = lintWorkflow(`
version: 1
name: if-empty-else
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
        else: []
`);
    expect(emptyElse.ok).toBe(false);
    expectDiagnostic(emptyElse, { code: "STEP_SHAPE", path: "$.workflow.steps[0].if.else", message: "if.else must be a non-empty array of steps" });

    const invalidCondition = lintWorkflow(`
version: 1
name: if-invalid-condition
workflow:
  steps:
    - id: maybe
      if:
        condition: 42
        then:
          - id: enabled
            run: program
            cmd: ["echo", "enabled"]
`);
    expect(invalidCondition.ok).toBe(false);
    expectDiagnostic(invalidCondition, { code: "IF_CONDITION_TYPE", path: "$.workflow.steps[0].if.condition" });
  });

  it("guard: compiles deterministic scoped control actions", () => {
    const source = `
version: 1
name: guard-output
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
        message: "blocked \${{ input.reason }}"
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const guardNode = result.ir?.root.children?.[0];
    expect(guardNode?.kind).toBe("guard");
    expect(guardNode?.metadata).toEqual({
      when: "input.ok",
      then: "continue",
      else: "fail",
      message: "blocked ${{ input.reason }}"
    });
    expect(result.schedule?.nodes[0]?.kind).toBe("guard");
    expect(result.ir?.expressions.some((expr) => expr.path === "$.workflow.steps[0].guard.message")).toBe(true);
  });

  it("loop: outputMerge is last; multi-step body takes last child", () => {
    const source = `
version: 1
name: loop-output
agents:
  mock: { type: command, use: "echo stub" }
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
    expect(loopNode?.children?.[0]?.kind).toBe("pipeline");
    expect(loopNode?.children?.[0]?.children?.map((c) => c.id)).toEqual(["step_a", "step_b"]);
  });

  it("subworkflow: no outputMerge field", () => {
    const source = `
version: 1
name: sub-workflow
agents:
  mock: { type: command, use: "echo stub" }
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

    const guardScheduleNode = result.schedule?.nodes[4];
    expect(guardScheduleNode?.kind).toBe("guard");
    expect(guardScheduleNode?.outputMerge).toBeUndefined();

    const switchScheduleNode = result.schedule?.nodes[5];
    expect(switchScheduleNode?.kind).toBe("switch");
    expect(switchScheduleNode?.outputMerge).toBe("selected");

    const loopScheduleNode = result.schedule?.nodes[6];
    expect(loopScheduleNode?.kind).toBe("loop");
    expect(loopScheduleNode?.outputMerge).toBe("last");

    const subworkflowScheduleNode = result.schedule?.nodes[8];
    expect(subworkflowScheduleNode?.kind).toBe("subworkflow");
    expect(subworkflowScheduleNode?.outputMerge).toBeUndefined();
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
    expectDiagnostic(result, { code: "FANOUT_QUORUM" });
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

  it("coerces boolean when to string", () => {
    const source = `
version: 1
name: coerce-when-bool
agents:
  mock: { type: command, use: "echo stub" }
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

  it("coerces guard boolean when to string", () => {
    const source = `
version: 1
name: guard-bool-when
workflow:
  steps:
    - id: check
      guard:
        when: false
        then: continue
        else: complete
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const guardNode = result.ir?.root.children?.[0];
    expect(guardNode?.kind).toBe("guard");
    expect(guardNode?.metadata.when).toBe("false");
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

  it("accepts numeric timeout (milliseconds)", () => {
    const source = `
version: 1
name: numeric-timeout
agents:
  mock: { type: command, use: "echo stub" }
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

  it("accepts valid on_error value", () => {
    const source = `
version: 1
name: good-on-error
agents:
  mock: { type: command, use: "echo stub" }
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

  it("accepts step ids without colons", () => {
    const source = `
version: 1
name: valid-id
workflow:
  steps:
    - id: my-step
      run: program
      cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
  });
});
