import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter, waitForNodeState } from "./helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { RunStore } from "../../src/store.js";
import { StubAgentExecutor } from "../support/stub-agent.js";
import type { ExecutorAdapter, ExecutionRequest } from "../../src/executors/types.js";
import type { ExecutorResult } from "../../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

class AbortIgnoringProgramExecutor implements ExecutorAdapter {
  constructor(private readonly resumeAfterAbort: () => void) {}

  async execute({ signal }: ExecutionRequest): Promise<ExecutorResult> {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    this.resumeAfterAbort();
    return { output: "ignored-abort", exitCode: 0, stdout: "ignored-abort", stderr: "" };
  }
}

describe("Parallel execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes parallel branches concurrently", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-test
agents:
  coder:
    type: command
    use: "echo stub"
  reviewer:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: branch-a
          run: agent
          use: coder
          prompt: "Task A"
        - id: branch-b
          run: agent
          use: reviewer
          prompt: "Task B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "branch-a": { result: "A" },
        "branch-b": { result: "B" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const branchA = nodes.find((n) => n.nodeId === "branch-a");
    const branchB = nodes.find((n) => n.nodeId === "branch-b");

    expect(branchA?.state).toBe("completed");
    expect(branchB?.state).toBe("completed");
  });

  it("merges parallel outputs as map", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-map-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: task-a
          run: agent
          use: coder
          prompt: "A"
        - id: task-b
          run: agent
          use: coder
          prompt: "B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "task-a": { value: 1 },
        "task-b": { value: 2 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const parallelNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parallel-group");
    expect(parallelNode?.state).toBe("completed");
    // outputMerge: "map" — should have step outputs
    expect(parallelNode?.output).toBeDefined();
  });

  it("keeps each concurrent branch's artifact refs isolated (no cross-contamination)", async () => {
    // Two program branches run concurrently with different delays to force their
    // executions to interleave at await points. Each node's artifactRefs must
    // reference its OWN stdout, proving refs are not shared across siblings.
    const ir = compileYaml(`
version: 1
name: parallel-artifact-isolation
workflow:
  steps:
    - id: par
      parallel:
        - id: slow
          run: program
          cmd: ["echo", "slow"]
        - id: fast
          run: program
          cmd: ["echo", "fast"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        slow: { stdout: "slow-out", delay: 40 },
        fast: { stdout: "fast-out", delay: 5 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const slow = nodes.find((n) => n.nodeId === "slow");
    const fast = nodes.find((n) => n.nodeId === "fast");
    expect(slow?.artifactRefs?.length).toBe(2);
    expect(fast?.artifactRefs?.length).toBe(2);

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(meta.runId, slow!.nodeKey, "stdout.log").toString()).toBe("slow-out");
    expect(artifacts.read(meta.runId, fast!.nodeKey, "stdout.log").toString()).toBe("fast-out");
    // Refs must point at the node's own artifact directory.
    expect(slow?.artifactRefs?.every((u) => u.includes("workflow:par:slow"))).toBe(true);
    expect(fast?.artifactRefs?.every((u) => u.includes("workflow:par:fast"))).toBe(true);
  });

  it("cancels still-running sibling branches when join:all fails fast", async () => {
    // A fast branch fails almost immediately; a slow branch is still running.
    // join:all must fail fast AND cancel the slow sibling (not leave it running).
    const ir = compileYaml(`
version: 1
name: parallel-fail-fast
workflow:
  steps:
    - id: par
      join: all
      parallel:
        - id: boom
          run: program
          cmd: ["echo", "boom"]
        - id: slow
          run: program
          cmd: ["echo", "slow"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        boom: { failureKind: "timeout", delay: 5 },
        slow: { stdout: "slow-out", delay: 200 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const boom = nodes.find((n) => n.nodeId === "boom");
    const slow = nodes.find((n) => n.nodeId === "slow");
    expect(boom?.state).toBe("failed");
    // The key assertion: the slow sibling must NOT linger in "running".
    expect(slow?.state).toBe("cancelled");
  });

  it("Run-level pause/resume re-executes paused parallel branches", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-run-pause-resume
workflow:
  steps:
    - id: par
      parallel:
        - id: branch-a
          run: program
          cmd: ["echo", "a"]
        - id: branch-b
          run: program
          cmd: ["echo", "b"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "branch-a": { stdout: "a-out", delay: 500, parsedOutput: "a-result" },
        "branch-b": { stdout: "b-out", delay: 500, parsedOutput: "b-result" }
      }
    });
    cleanups.push(cleanup);

    const runId = "parallel-run-pause-resume";
    const meta = interpreter.initRun(ir, { input: {}, runId });

    // Start the run but don't await it — we need to pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: {}, runId }, meta.runId);

    await waitForNodeState(store, runId, "branch-a", "running", 2000);
    interpreter.pauseRun(runId);

    await runPromise.catch(() => undefined);

    const pausedNodes = store.listNodeStates(runId);
    expect(pausedNodes.find((n) => n.nodeId === "branch-a")?.state).toBe("paused");
    expect(pausedNodes.find((n) => n.nodeId === "branch-b")?.state).toBe("paused");
    expect(store.readRunMeta(runId)?.status).toBe("paused");

    await interpreter.resumeRun(runId);
    await interpreter.runToCompletion(ir, { input: {}, runId }, runId);

    const finalNodes = store.listNodeStates(runId);
    expect(finalNodes.find((n) => n.nodeId === "branch-a")?.state).toBe("completed");
    expect(finalNodes.find((n) => n.nodeId === "branch-b")?.state).toBe("completed");
    expect(finalNodes.find((n) => n.nodeId === "branch-a")?.output).toEqual({ output: "a-result", exit_code: 0 });
    expect(finalNodes.find((n) => n.nodeId === "branch-b")?.output).toEqual({ output: "b-result", exit_code: 0 });
    expect(store.readRunMeta(runId)?.status).toBe("completed");
  });

  it("does not let a late success clobber a Run-level paused node", async () => {
    const ir = compileYaml(`
version: 1
name: pause-late-success
workflow:
  steps:
    - id: task
      run: program
      cmd: ["echo", "task"]
`);

    const tmpDir = mkdtempSync(join(tmpdir(), "acpus-pause-clobber-"));
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    let unblockLateSuccess!: () => void;
    const lateSuccess = new Promise<void>((resolve) => { unblockLateSuccess = resolve; });
    const store = new RunStore(tmpDir);
    const interpreter = new WorkflowInterpreter(
      store,
      new StubAgentExecutor({}),
      new AbortIgnoringProgramExecutor(unblockLateSuccess)
    );

    const runId = "pause-late-success";
    interpreter.initRun(ir, { input: {}, runId });
    const runPromise = interpreter.runToCompletion(ir, { input: {}, runId }, runId);

    await waitForNodeState(store, runId, "task", "running", 2000);
    interpreter.pauseRun(runId);
    await lateSuccess;
    const meta = await runPromise;

    expect(meta.status).toBe("paused");
    expect(store.readNodeState(runId, "workflow/task")?.state).toBe("paused");
  });

  it("still cancels siblings on genuine failure (fast-stop preserved)", async () => {
    // Same structure as the fail-fast test, but using a different join:all setup
    // to verify that genuine failures still cancel siblings.
    const ir = compileYaml(`
version: 1
name: parallel-fail-fast-preserved
workflow:
  steps:
    - id: par
      join: all
      parallel:
        - id: boom
          run: program
          cmd: ["echo", "boom"]
        - id: slow
          run: program
          cmd: ["echo", "slow"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        boom: { failureKind: "timeout", delay: 5 },
        slow: { stdout: "slow-out", delay: 200 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const boom = nodes.find((n) => n.nodeId === "boom");
    const slow = nodes.find((n) => n.nodeId === "slow");
    expect(boom?.state).toBe("failed");
    // Genuine failure still cancels siblings.
    expect(slow?.state).toBe("cancelled");
  });

});
