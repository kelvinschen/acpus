import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Guard execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("fails the run with structured output and a rendered message", async () => {
    const ir = compileYaml(`
version: 1
name: guard-fail-test
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
        message: "blocked: \${{ input.reason }}"
    - id: after
      run: program
      cmd: ["echo", "after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { after: { stdout: "after" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { ok: false, reason: "not-ready" } });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const guard = nodes.find((n) => n.nodeId === "check");
    const after = nodes.find((n) => n.nodeId === "after");
    expect(guard?.state).toBe("failed");
    expect(guard?.error).toBe("blocked: not-ready");
    expect(guard?.output).toEqual({ matched: false, action: "fail", message: "blocked: not-ready" });
    expect(after).toBeUndefined();
  });

  it("fail without message uses default error and no message output", async () => {
    const ir = compileYaml(`
version: 1
name: guard-default-fail-test
workflow:
  steps:
    - id: check
      guard:
        when: false
        then: continue
        else: fail
    - id: after
      run: program
      cmd: ["echo", "after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { after: { stdout: "after" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const guard = nodes.find((n) => n.nodeId === "check");
    expect(guard?.state).toBe("failed");
    expect(guard?.error).toBe("Guard 'check' failed");
    expect(guard?.output).toEqual({ matched: false, action: "fail" });
    expect(nodes.find((n) => n.nodeId === "after")).toBeUndefined();
  });

  it("completes the root scope early and skips later nodes", async () => {
    const ir = compileYaml(`
version: 1
name: guard-complete-test
workflow:
  steps:
    - id: no_work
      guard:
        when: len(input.items) == 0
        then: complete
        else: continue
        message: "nothing to do"
    - id: after
      run: program
      cmd: ["echo", "after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { after: { stdout: "after" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: [] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "no_work")?.output).toEqual({
      matched: true,
      action: "complete",
      message: "nothing to do"
    });
    expect(nodes.find((n) => n.nodeId === "after")).toBeUndefined();
  });

  it("continue without message supports boolean true literal", async () => {
    const ir = compileYaml(`
version: 1
name: guard-continue-true-test
workflow:
  steps:
    - id: check
      guard:
        when: true
        then: continue
        else: fail
    - id: after
      run: program
      cmd: ["echo", "after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { after: { stdout: "after" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "check")?.output).toEqual({ matched: true, action: "continue" });
    expect(nodes.find((n) => n.nodeId === "after")?.state).toBe("completed");
  });

  it("exposes continue output to later expressions", async () => {
    const ir = compileYaml(`
version: 1
name: guard-output-test
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
    - id: assert_output
      guard:
        when: steps.check.action == "continue"
        then: continue
        else: fail
`);

    const { interpreter, store, cleanup } = createTestInterpreter();
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { ok: true } });
    expect(meta.status).toBe("completed");
    expect(store.listNodeStates(meta.runId).find((n) => n.nodeId === "assert_output")?.state).toBe("completed");
  });

  it("evaluation error fails guard node", async () => {
    const ir = compileYaml(`
version: 1
name: guard-evaluation-error-test
workflow:
  steps:
    - id: check
      guard:
        when: nonexistent_var
        then: continue
        else: fail
    - id: after
      run: program
      cmd: ["echo", "after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { after: { stdout: "after" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const guard = nodes.find((n) => n.nodeId === "check");
    expect(guard?.state).toBe("failed");
    expect(guard?.error).toEqual(expect.any(String));
    expect(guard?.error).not.toBe("");
    expect(nodes.find((n) => n.nodeId === "after")).toBeUndefined();
  });

  it("completes only the current fanout lane", async () => {
    const ir = compileYaml(`
version: 1
name: guard-fanout-scope-test
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        key: "\${{ item.id }}"
        join: all
        do:
          - id: maybe_skip
            guard:
              when: item.skip
              then: complete
              else: continue
              message: "skipped \${{ item.id }}"
          - id: work
            run: program
            cmd: ["echo", "\${{ item.id }}"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { work: { stdout: "worked" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: [{ id: "skip", skip: true }, { id: "run", skip: false }] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.filter((n) => n.nodeId === "maybe_skip" && n.state === "completed")).toHaveLength(2);
    expect(nodes.filter((n) => n.nodeId === "work" && n.state === "completed")).toHaveLength(1);
  });

  it("complete inside switch case skips only case siblings", async () => {
    const ir = compileYaml(`
version: 1
name: guard-switch-complete-test
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: true
            do:
              - id: stop_case
                guard:
                  when: true
                  then: complete
                  else: continue
              - id: case_after
                run: program
                cmd: ["echo", "case-after"]
        default:
          do:
            - id: default_after
              run: program
              cmd: ["echo", "default-after"]
    - id: root_after
      run: program
      cmd: ["echo", "root-after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        case_after: { stdout: "case-after" },
        default_after: { stdout: "default-after" },
        root_after: { stdout: "root-after" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "route")?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "stop_case")?.output).toEqual({ matched: true, action: "complete" });
    expect(nodes.find((n) => n.nodeId === "case_after")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "default_after")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "root_after")?.state).toBe("completed");
  });

  it("complete inside loop exits loop scope", async () => {
    const ir = compileYaml(`
version: 1
name: guard-loop-complete-test
workflow:
  steps:
    - id: repeat
      loop:
        until: false
        max_iterations: 3
        do:
          - id: stop_loop
            guard:
              when: true
              then: complete
              else: continue
          - id: loop_after
            run: program
            cmd: ["echo", "loop-after"]
    - id: root_after
      run: program
      cmd: ["echo", "root-after"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        loop_after: { stdout: "loop-after" },
        root_after: { stdout: "root-after" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "repeat")?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "repeat")?.output).toEqual({ matched: true, action: "complete" });
    expect(nodes.find((n) => n.nodeId === "stop_loop")?.output).toEqual({ matched: true, action: "complete" });
    expect(nodes.find((n) => n.nodeId === "loop_after")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "root_after")?.state).toBe("completed");
  });

  it("uses existing parallel fail-fast cancellation when a guard fails", async () => {
    const ir = compileYaml(`
version: 1
name: guard-parallel-fail-fast-test
workflow:
  steps:
    - id: branches
      max_concurrency: 2
      parallel:
        - id: stop
          guard:
            when: false
            then: continue
            else: fail
        - id: slow
          run: program
          cmd: ["echo", "slow"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { slow: { stdout: "slow", delay: 100 } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "stop")?.state).toBe("failed");
    expect(nodes.find((n) => n.nodeId === "slow")?.state).toBe("cancelled");
  });
});
