import { describe, it, expect, afterEach } from "vitest";
import { compileYaml } from "../interpreter/helper.js";
import { RunStore } from "../../src/store.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { StubAgentExecutor } from "../support/stub-agent.js";
import type { ExecutorAdapter, ProgramExecutionRequest } from "../../src/executors/types.js";
import type { ExecutorResult, ExpressionContext } from "../../src/types.js";
import { ExpressionEvaluator } from "../../src/evaluator.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A program executor that records the resolved cmd template it received on each
 * call (so a test can assert that retry re-rendered with the parent's
 * dynamic item/loop context). It can be told to fail on the first call to a
 * given step so retry re-enters the leaf.
 */
class RecordingProgramExecutor implements ExecutorAdapter<ProgramExecutionRequest> {
  readonly renders: Array<{ nodeKey: string; cmd: string; ctx: ExpressionContext }> = [];
  private readonly evaluator = new ExpressionEvaluator();
  private readonly failFirst: Set<string>;
  private readonly seen = new Set<string>();

  constructor(failFirst: string[] = []) {
    this.failFirst = new Set(failFirst);
  }

  async execute({ node, context, nodeKey }: ProgramExecutionRequest): Promise<ExecutorResult> {
    const cmdTemplate = node.metadata.cmd as string | string[] | undefined;
    const cmd = Array.isArray(cmdTemplate)
      ? cmdTemplate.map((c) => this.evaluator.evaluateTemplate(c, context)).join(" ")
      : this.evaluator.evaluateTemplate(cmdTemplate ?? "", context);
    this.renders.push({ nodeKey, cmd, ctx: { ...context } });

    if (this.failFirst.has(node.id) && !this.seen.has(nodeKey)) {
      this.seen.add(nodeKey);
      return { failureKind: "exit", error: "forced first-attempt failure", stdout: "", stderr: "" };
    }
    return { output: cmd, exitCode: 0, stdout: cmd, stderr: "" };
  }
}

function makeInterpreter(program: ExecutorAdapter<ProgramExecutionRequest>): { interpreter: WorkflowInterpreter; store: RunStore; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "acpus-dynctx-"));
  const store = new RunStore(tmpDir);
  const agent = new StubAgentExecutor({});
  const interpreter = new WorkflowInterpreter(store, agent, program, {
    nowTimestamp: "2025-01-01T00:00:00Z",
    sleep: () => Promise.resolve()
  });
  return { interpreter, store, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

describe("Dynamic context persistence (retry)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("restores fanout item context on retry so cmd re-renders with item.*", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-dynctx
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        do:
          - id: handle
            run: program
            cmd: ["process", "\${{ item }}"]
`);

    // Force the first attempt of each lane to fail, then retry each failed node.
    const program = new RecordingProgramExecutor(["handle"]);
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["alpha", "beta"] } });
    expect(meta.status).toBe("failed");

    const failedLeaves = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "handle" && n.state === "failed");
    expect(failedLeaves.length).toBe(2);
    // Each failed leaf persisted its parent item context.
    for (const leaf of failedLeaves) {
      expect(leaf.dynamicContext?.item).toBeDefined();
    }

    // Retry each failed lane leaf; the re-render must see the SAME item value.
    program.renders.length = 0;
    for (const leaf of failedLeaves) {
      await interpreter.retryNode(meta.runId, leaf.nodeKey);
    }

    // After retry, both leaves complete and their re-rendered cmd carries item.*
    const completed = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "handle" && n.state === "completed");
    expect(completed.length).toBe(2);
    const renderedCmds = program.renders.map((r) => r.cmd).sort();
    expect(renderedCmds).toEqual(["process alpha", "process beta"]);
    // The restored context carried the item value (not undefined).
    expect(program.renders.every((r) => r.ctx.item !== undefined)).toBe(true);
  });

  it("restores loop.iter context on retry of a loop-body leaf", async () => {
    const ir = compileYaml(`
version: 1
name: loop-dynctx
workflow:
  steps:
    - id: spin
      loop:
        until: loop.iter >= 2
        max_iterations: 3
        do:
          - id: tick
            run: program
            cmd: ["tick", "\${{ loop.iter }}"]
`);

    // Fail the very first leaf execution (iter 0) so we can retry it.
    const program = new RecordingProgramExecutor(["tick"]);
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const failed = store.listNodeStates(meta.runId).find((n) => n.nodeId === "tick" && n.state === "failed");
    expect(failed).toBeDefined();
    expect(failed?.dynamicContext?.loop?.iter).toBe(0);

    program.renders.length = 0;
    await interpreter.retryNode(meta.runId, failed!.nodeKey);

    // The retried leaf re-rendered with loop.iter = 0 restored from disk.
    const retried = program.renders.find((r) => r.nodeKey === failed!.nodeKey);
    expect(retried?.cmd).toBe("tick 0");
    expect(retried?.ctx.loop?.iter).toBe(0);
  });

  it("does not leak private sibling branch outputs into node retry context", async () => {
    const ir = compileYaml(`
version: 1
name: retry-frame-scope
input:
  ref: string
workflow:
  steps:
    - id: branches
      parallel:
        - id: left
          do:
            - id: private_left
              run: program
              cmd: ["left"]
        - id: right
          do:
            - id: retry_me
              run: program
              cmd: ["retry", "\${{ steps[input.ref].output }}"]
`);
    const program = new RecordingProgramExecutor(["retry_me"]);
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { ref: "private_left" } });
    expect(meta.status).toBe("failed");
    const failed = store.listNodeStates(meta.runId).find((n) => n.nodeId === "retry_me");
    expect(failed?.state).toBe("failed");

    program.renders.length = 0;
    await expect(interpreter.retryNode(meta.runId, failed!.nodeKey)).rejects.toThrow(/No such key|private_left/);
    expect(program.renders).toEqual([]);
  });

  it("hydrates explicit pipeline frame outputs when retrying a pipeline child", async () => {
    const ir = compileYaml(`
version: 1
name: retry-explicit-pipeline-frame
workflow:
  steps:
    - id: bundle
      pipeline:
        - id: prepare
          run: program
          cmd: ["prepare"]
        - id: retry_me
          run: program
          cmd: ["retry", "\${{ steps.prepare.output }}"]
`);
    const program = new RecordingProgramExecutor(["retry_me"]);
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    const failed = store.listNodeStates(meta.runId).find((n) => n.nodeId === "retry_me");
    expect(failed?.state).toBe("failed");

    program.renders.length = 0;
    await interpreter.retryNode(meta.runId, failed!.nodeKey);
    expect(program.renders.find((r) => r.nodeKey === failed!.nodeKey)?.cmd).toBe("retry prepare");
  });
});

describe("Control-plane retry semantics", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("retry increments attempt by exactly one (no double-count)", async () => {
    const ir = compileYaml(`
version: 1
name: retry-attempt
workflow:
  steps:
    - id: once
      run: program
      cmd: ["go"]
`);
    // Always-fail so we can observe attempt across a retry.
    const program = new RecordingProgramExecutor(["once"]);
    // RecordingProgramExecutor only fails the FIRST time per nodeKey; force a
    // second failure by re-marking after the initial run.
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    const failed = store.listNodeStates(meta.runId).find((n) => n.nodeId === "once");
    expect(failed?.state).toBe("failed");
    const attemptAfterFirst = failed!.attempt;

    await interpreter.retryNode(meta.runId, failed!.nodeKey);
    const afterRetry = store.readNodeState(meta.runId, failed!.nodeKey);
    // Exactly +1 from the single executeNode increment (retryNode does not
    // pre-increment).
    expect(afterRetry!.attempt).toBe(attemptAfterFirst + 1);
  });

  it("rejects retry of a non-failed (completed) node with a clear message", async () => {
    const ir = compileYaml(`
version: 1
name: retry-completed
workflow:
  steps:
    - id: ok
      run: program
      cmd: ["go"]
`);
    const program = new RecordingProgramExecutor(); // never fails
    const { interpreter, store, cleanup } = makeInterpreter(program);
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "ok");
    expect(node?.state).toBe("completed");

    await expect(interpreter.retryNode(meta.runId, node!.nodeKey)).rejects.toThrow(/only failed executable nodes are retryable/);
  });
});
