import { describe, it, expect, afterEach } from "vitest";
import { compileWorkflow } from "@acpus/core";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Subworkflow execution", () => {
  const cleanups: Array<() => void> = [];

  function compileFile(path: string) {
    const result = compileWorkflow(readFileSync(path, "utf8"), {
      sourcePath: path,
      includeResolver: () => { throw new Error("no includes expected"); }
    });
    if (!result.ok || !result.ir) {
      throw new Error("Compilation failed");
    }
    return result.ir;
  }

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("compiles and runs a child spec, nesting child node keys under the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-"));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child
input:
  topic: string
workflow:
  steps:
    - id: child_step
      run: program
      cmd: ["echo", "hi"]
`);

    const ir = compileYaml(`
version: 1
name: parent
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
      input:
        topic: ${"${{ input.topic }}"}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { child_step: { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: { topic: "x" } });
    expect(meta.status).toBe("completed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("completed");
    expect(sub?.output).toEqual({ output: {} });

    // The child node key is nested under the parent subworkflow node key.
    const childNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "child_step");
    expect(childNode?.state).toBe("completed");
    expect(childNode?.nodeKey.startsWith("workflow/sub/")).toBe(true);
  });

  it("exposes the child workflow's declared outputs projection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-output-"));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-output
workflow:
  steps:
    - id: child_step
      run: program
      cmd: ["echo", "{}"]
      capture:
        from: stdout
        parse: json
      output:
        value: string
outputs:
  result: \${{ steps.child_step.output.value }}
`);

    const ir = compileYaml(`
version: 1
name: parent-output
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { child_step: { parsedOutput: { value: "projected" }, stdout: "{\"value\":\"projected\"}" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.output).toEqual({ output: { result: "projected" } });
  });

  it("uses child workflow metadata inside subworkflow outputs", async () => {
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-subwf-parent-meta-")));
    const childDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-subwf-child-meta-")));
    const parentPath = join(parentDir, "parent.yaml");
    const childPath = join(childDir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-meta
description: Child metadata
workflow:
  steps: []
outputs:
  name: \${{ workflow.name }}
  description: \${{ workflow.description }}
  source_path: \${{ workflow.source_path }}
  source_dir: \${{ workflow.source_dir }}
`);

    const ir = compileYaml(`
version: 1
name: parent-meta
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
outputs:
  parent_dir: \${{ workflow.source_dir }}
  child_dir: \${{ steps.sub.output.source_dir }}
`);
    ir.source.path = parentPath;

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(parentDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(childDir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    expect(meta.output).toEqual({ parent_dir: parentDir, child_dir: childDir });

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.output).toEqual({
      output: {
        name: "child-meta",
        description: "Child metadata",
        source_path: childPath,
        source_dir: childDir
      }
    });
  });

  it("persists evaluated child input for a successful subworkflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-input-"));
    const parentPath = join(dir, "parent.yaml");
    const childPath = join(dir, "child.yaml");
    const expectedInput = {
      amount: 42.5,
      tags: ["alpha", "beta"],
      payload: {
        title: "Nested payload",
        nested: {
          score: 7,
          flags: [true, false]
        }
      }
    };

    writeFileSync(childPath, `
version: 1
name: child-input-observation
input:
  amount: number
  tags: [string]
  payload:
    title: string
    nested:
      score: integer
      flags: [boolean]
workflow:
  steps:
    - id: inspect_complex
      run: program
      cmd:
        - ${JSON.stringify(process.execPath)}
        - -e
        - |
          const tags = JSON.parse(process.env.TAGS_JSON);
          const payload = JSON.parse(process.env.PAYLOAD_JSON);
          console.log(JSON.stringify({
            amount: Number(process.env.AMOUNT),
            tags,
            payload
          }));
      env:
        AMOUNT: "\${{ input.amount }}"
        TAGS_JSON: "\${{ json(input.tags) }}"
        PAYLOAD_JSON: "\${{ json(input.payload) }}"
      capture:
        from: stdout
        parse: json
      output:
        amount: number
        tags: [string]
        payload:
          title: string
          nested:
            score: integer
            flags: [boolean]
outputs:
  amount: \${{ steps.inspect_complex.output.amount }}
  tags: \${{ steps.inspect_complex.output.tags }}
  payload: \${{ steps.inspect_complex.output.payload }}
`);

    writeFileSync(parentPath, `
version: 1
name: parent-input-observation
workflow:
  steps:
    - id: make_complex
      run: program
      cmd:
        - ${JSON.stringify(process.execPath)}
        - -e
        - |
          console.log(JSON.stringify({
            amount: 42.5,
            tags: ["alpha", "beta"],
            payload: {
              title: "Nested payload",
              nested: {
                score: 7,
                flags: [true, false]
              }
            }
          }));
      capture:
        from: stdout
        parse: json
      output:
        amount: number
        tags: [string]
        payload:
          title: string
          nested:
            score: integer
            flags: [boolean]
    - id: sub
      subworkflow: child.yaml
      input:
        amount: "\${{ steps.make_complex.output.amount }}"
        tags: "\${{ steps.make_complex.output.tags }}"
        payload: "\${{ steps.make_complex.output.payload }}"
outputs:
  amount: \${{ steps.sub.output.amount }}
  tags: \${{ steps.sub.output.tags }}
  payload: \${{ steps.sub.output.payload }}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({ useRealProgramExecutor: true });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(compileFile(parentPath), { input: {} });
    expect(meta.status).toBe("completed");
    expect(meta.output).toEqual(expectedInput);

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("completed");
    expect(sub?.input).toEqual(expectedInput);

    const child = store.listNodeStates(meta.runId).find((n) => n.nodeId === "inspect_complex");
    expect(child?.output).toEqual({ output: expectedInput, exit_code: 0 });
  });

  it("keeps evaluated child input when the child workflow fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-input-failure-"));
    const childPath = join(dir, "child.yaml");
    const expectedInput = {
      amount: 3,
      tags: ["will", "fail"],
      payload: {
        title: "Still visible",
        nested: {
          score: 9,
          flags: [false]
        }
      }
    };

    writeFileSync(childPath, `
version: 1
name: child-input-failure
input:
  amount: number
  tags: [string]
  payload:
    title: string
    nested:
      score: integer
      flags: [boolean]
workflow:
  steps:
    - id: fail_child
      run: program
      cmd: ["echo", "boom"]
`);

    const ir = compileYaml(`
version: 1
name: parent-input-failure
workflow:
  steps:
    - id: make_complex
      run: program
      cmd: ["echo", "{}"]
      capture:
        from: stdout
        parse: json
      output:
        amount: number
        tags: [string]
        payload:
          title: string
          nested:
            score: integer
            flags: [boolean]
    - id: sub
      subworkflow: ${childPath}
      input:
        amount: "\${{ steps.make_complex.output.amount }}"
        tags: "\${{ steps.make_complex.output.tags }}"
        payload: "\${{ steps.make_complex.output.payload }}"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        make_complex: { parsedOutput: expectedInput, stdout: JSON.stringify(expectedInput) },
        fail_child: { failureKind: "spawn", stderr: "boom" }
      }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
    expect(sub?.input).toEqual(expectedInput);
  });

  it("fails when the child spec cannot be found", async () => {
    const ir = compileYaml(`
version: 1
name: parent-missing-child
workflow:
  steps:
    - id: sub
      subworkflow: /nonexistent/acpus-child-missing.yaml
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
  });

  it("accepts subworkflow specs from any directory", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "acpus-subwf-anywhere-"));
    const childPath = join(outsideDir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-anywhere
workflow:
  steps:
    - id: child-step
      run: program
      cmd: ["echo", "hi"]
`);

    const ir = compileYaml(`
version: 1
name: parent-anywhere
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { "child-step": { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("completed");
  });

  it("fails when the child spec does not compile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-bad-"));
    const childPath = join(dir, "child.yaml");
    // Missing required top-level fields → compile error.
    writeFileSync(childPath, `not: a valid workflow spec\n`);

    const ir = compileYaml(`
version: 1
name: parent-bad-child
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
  });

  it("fails on a subworkflow cycle (child references itself)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-cycle-"));
    const childPath = join(dir, "child.yaml");
    // The child invokes itself, creating a cycle.
    writeFileSync(childPath, `
version: 1
name: child-cycle
workflow:
  steps:
    - id: again
      subworkflow: ${childPath}
`);

    const ir = compileYaml(`
version: 1
name: parent-cycle
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
  });

  it("rejects retry of a subworkflow child node without mutating its state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-resume-"));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child
workflow:
  steps:
    - id: child-step
      run: program
      cmd: ["echo", "hi"]
`);

    const ir = compileYaml(`
version: 1
name: parent
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    // The child step fails non-recoverably, so its persisted state is `failed`
    // — which lets us exercise retry's IR-lookup guard (a completed node would
    // be rejected earlier by the "only failed nodes are retryable" check).
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { "child-step": { failureKind: "spawn", stderr: "boom" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const childNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "child-step");
    expect(childNode?.nodeKey.startsWith("workflow/sub/")).toBe(true);
    expect(childNode?.state).toBe("failed");
    const childKey = childNode!.nodeKey;

    // The child IR is not persisted in the parent run, so its definition cannot
    // be resolved here: retry must reject rather than silently no-op.
    await expect(interpreter.retryNode(meta.runId, childKey)).rejects.toThrow(/not.*found in the run's IR/);

    // State must be untouched (no dirty running/pending left behind).
    expect(store.readNodeState(meta.runId, childKey)?.state).toBe("failed");
  });

  it("resolves relative subworkflow paths from parent sourcePath in /tmp", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "acpus-subwf-rel-"));
    const parentPath = join(tmpDir, "parent.yaml");
    const childPath = join(tmpDir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-relative
workflow:
  steps:
    - id: child-step
      run: program
      cmd: ["echo", "hi"]
`);
    writeFileSync(parentPath, `
version: 1
name: parent-relative
workflow:
  steps:
    - id: sub
      subworkflow: child.yaml
`);

    const ir = compileFile(parentPath);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { "child-step": { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("completed");
  });

  it("fails for non-existent subworkflow paths with does not exist or is not readable", async () => {
    const ir = compileYaml(`
version: 1
name: parent-nonexistent
workflow:
  steps:
    - id: sub
      subworkflow: /nonexistent/acpus-child-nonexistent.yaml
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
    expect(sub?.error).toMatch(/does not exist or is not readable/);
  });

  it("allows parallel branches to call the same subworkflow without false cycle detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-parallel-"));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-parallel
workflow:
  steps:
    - id: child_step
      run: program
      cmd: ["echo", "hi"]
`);

    const ir = compileYaml(`
version: 1
name: parent-parallel
workflow:
  steps:
    - id: par
      parallel:
        - id: branch_a
          do:
            - id: call_a
              subworkflow: ${childPath}
        - id: branch_b
          do:
            - id: call_b
              subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { child_step: { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const par = store.listNodeStates(meta.runId).find((n) => n.nodeId === "par");
    expect(par?.state).toBe("completed");
  });

  it("allows fanout lanes to call the same subworkflow without false cycle detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-fanout-"));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-fanout
workflow:
  steps:
    - id: child_step
      run: program
      cmd: ["echo", "hi"]
`);

    const ir = compileYaml(`
version: 1
name: parent-fanout
input:
  items: [string]
workflow:
  steps:
    - id: fan
      fanout:
        over: input.items
        join: all
        do:
          - id: call_item
            subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { child_step: { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: { items: ["a", "b", "c"] } });
    expect(meta.status).toBe("completed");

    const fan = store.listNodeStates(meta.runId).find((n) => n.nodeId === "fan");
    expect(fan?.state).toBe("completed");
  });

  it("detects genuine subworkflow cycles across nested calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-subwf-nested-cycle-"));
    const childPath = join(dir, "child.yaml");
    const grandchildPath = join(dir, "grandchild.yaml");
    // grandchild → child → creates A→B→A cycle
    writeFileSync(grandchildPath, `
version: 1
name: grandchild-cycle
workflow:
  steps:
    - id: back_to_child
      subworkflow: ${childPath}
`);
    writeFileSync(childPath, `
version: 1
name: child-cycle
workflow:
  steps:
    - id: call_grandchild
      subworkflow: ${grandchildPath}
`);

    const ir = compileYaml(`
version: 1
name: parent-nested-cycle
workflow:
  steps:
    - id: sub
      subworkflow: ${childPath}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
    expect(sub?.error).toMatch(/cycle/i);
  });

  it("resolves relative subworkflows inside child parallel branches from the child spec directory", async () => {
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-subwf-child-parallel-")));
    const childDir = join(parentDir, "child");
    mkdirSync(childDir);
    const parentPath = join(parentDir, "parent.yaml");
    const childPath = join(childDir, "child.yaml");
    const grandchildPath = join(childDir, "grandchild.yaml");
    writeFileSync(grandchildPath, `
version: 1
name: grandchild-relative-parallel
workflow:
  steps:
    - id: grand_step
      run: program
      cmd: ["echo", "hi"]
`);
    writeFileSync(childPath, `
version: 1
name: child-relative-parallel
workflow:
  steps:
    - id: child_parallel
      parallel:
        - id: branch_a
          do:
            - id: call_a
              subworkflow: grandchild.yaml
        - id: branch_b
          do:
            - id: call_b
              subworkflow: grandchild.yaml
`);
    writeFileSync(parentPath, `
version: 1
name: parent-relative-parallel
workflow:
  steps:
    - id: sub
      subworkflow: child/child.yaml
`);

    const ir = compileFile(parentPath);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { grand_step: { parsedOutput: { done: true }, stdout: "hi" } }
    });
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(parentDir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const childParallel = store.listNodeStates(meta.runId).find((n) => n.nodeId === "child_parallel");
    expect(childParallel?.state).toBe("completed");
  });

  it("preserves subworkflow cycle detection after child loop dynamics", async () => {
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-subwf-loop-cycle-")));
    const childDir = join(parentDir, "child");
    mkdirSync(childDir);
    const parentPath = join(parentDir, "parent.yaml");
    const childPath = join(childDir, "child.yaml");
    const grandchildPath = join(childDir, "grandchild.yaml");
    writeFileSync(grandchildPath, `
version: 1
name: grandchild-loop-cycle
workflow:
  steps:
    - id: back_to_child
      subworkflow: child.yaml
`);
    writeFileSync(childPath, `
version: 1
name: child-loop-cycle
workflow:
  steps:
    - id: child_loop
      loop:
        max_iterations: 1
        do:
          - id: call_grandchild
            subworkflow: grandchild.yaml
`);
    writeFileSync(parentPath, `
version: 1
name: parent-loop-cycle
workflow:
  steps:
    - id: sub
      subworkflow: child/child.yaml
`);

    const ir = compileFile(parentPath);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    cleanups.push(() => rmSync(parentDir, { recursive: true, force: true }));

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const sub = store.listNodeStates(meta.runId).find((n) => n.nodeId === "sub");
    expect(sub?.state).toBe("failed");
    expect(sub?.error).toMatch(/cycle/i);
  });
});
