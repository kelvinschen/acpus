import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Subworkflow execution", () => {
  const cleanups: Array<() => void> = [];

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

    // Read and compile the parent with sourcePath so relative resolution works.
    const { compileWorkflow } = await import("@acpus/core");
    const result = compileWorkflow(readFileSync(parentPath, "utf8"), {
      sourcePath: parentPath,
      includeResolver: () => { throw new Error("no includes expected"); }
    });
    if (!result.ok || !result.ir) {
      throw new Error("Compilation failed");
    }
    const ir = result.ir;

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
});
