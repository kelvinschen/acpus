import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { RunStore } from "../../src/store.js";
import { StubAgentExecutor } from "../support/stub-agent.js";
import type { ExecutorAdapter, ExecutionRequest } from "../../src/executors/types.js";
import type { ExecutorResult } from "../../src/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

class ItemProgramExecutor implements ExecutorAdapter {
  async execute({ context, signal }: ExecutionRequest): Promise<ExecutorResult> {
    if (context.item === "boom") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { failureKind: "timeout", error: "boom", stdout: "", stderr: "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (signal.aborted) {
      return { partial: true, error: "aborted" };
    }
    return { stdout: String(context.item), stderr: "" };
  }
}

class CrossLaneProgramExecutor implements ExecutorAdapter {
  async execute({ node, nodeKey, signal }: ExecutionRequest): Promise<ExecutorResult> {
    const outerLaneA = nodeKey.includes("item:a/lane:0") && nodeKey.includes("/sub_a/");
    await new Promise((resolve) => setTimeout(resolve, outerLaneA ? 5 : 80));
    if (signal.aborted) {
      return { partial: true, error: "aborted" };
    }
    if (node.id === "child_work" && outerLaneA) {
      return { failureKind: "timeout", error: "lane-a failed", stdout: "", stderr: "" };
    }
    return { stdout: "ok", stderr: "" };
  }
}

describe("Fanout join and success criteria", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("join: all fails the fanout when a lane fails (default min_success = lane count)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-all-fail
agents:
  coder:
    type: command
    use: echo stub
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        do:
          - id: work
            run: agent
            use: coder
            prompt: work
`);

    // Only the first lane has a response; the second lane fails (no response).
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { sequence: [{ output: { ok: true } }, { failureKind: "schema" }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("failed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("failed");
  });

  it("succeeds when successful lanes meet success_criteria.min_success", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-min-success
agents:
  coder:
    type: command
    use: echo stub
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        success_criteria:
          min_success: 1
        do:
          - id: work
            run: agent
            use: coder
            prompt: work
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { sequence: [{ output: { ok: true } }, { failureKind: "schema" }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    // Output is the array of successful lane outputs (one success).
    expect(fanout?.output).toEqual({ output: [{ ok: true }] });
  });

  it("join: race completes on the first lane and outputs a single success (default min_success = 1)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-race
agents:
  coder:
    type: command
    use: echo stub
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: race
        do:
          - id: work
            run: agent
            use: coder
            prompt: work
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      // The fast lane resolves first; the slow lane is not awaited for success.
      agentResponses: { work: { sequence: [{ output: { who: "fast" }, delay: 1 }, { output: { who: "slow" }, delay: 50 }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    expect(fanout?.output).toEqual({ output: [{ who: "fast" }] });
  });

  it("join: quorum completes once the quorum count of lanes settle (default min_success = quorum)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-quorum
agents:
  coder:
    type: command
    use: echo stub
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: quorum
        quorum: 2
        do:
          - id: work
            run: agent
            use: coder
            prompt: work
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { ok: true } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b", "c"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    // Quorum of 2 successful lanes satisfies the default min_success.
    expect(fanout?.output).toEqual({ output: [{ ok: true }, { ok: true }] });
  });

  it("join: all fails fast and cancels still-running nodes across other lanes", async () => {
    // Two modules fan out; each lane runs a parallel of a fast-failing branch
    // and a slow branch. When one lane's fast branch fails, the whole fanout
    // (join:all) becomes unsatisfiable and must fail fast: every still-running
    // node in EVERY lane is cancelled rather than left running.
    const ir = compileYaml(`
version: 1
name: fanout-fail-fast
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        do:
          - id: lane_work
            join: all
            parallel:
              - id: boom
                do:
                  - id: boom
                    run: program
                    cmd:
                      - echo
                      - boom
              - id: slow
                do:
                  - id: slow
                    run: program
                    cmd:
                      - echo
                      - slow
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        boom: { failureKind: "timeout", delay: 5 },
        slow: { stdout: "slow-out", delay: 300 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    // No node may linger in a non-terminal state once the run has failed.
    const nonTerminal = nodes.filter((n) => n.state === "running" || n.state === "pending" || n.state === "awaiting");
    expect(nonTerminal).toEqual([]);
    // Every `slow` branch (both lanes) must be cancelled, none completed.
    const slows = nodes.filter((n) => n.nodeId === "slow");
    expect(slows.length).toBeGreaterThan(0);
    for (const s of slows) expect(s.state).toBe("cancelled");
  });

  it("join: all fails fast and cancels queued pending lanes", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-fail-fast-queued
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        max_concurrency: 2
        do:
          - id: work
            run: program
            cmd:
              - echo
              - work
`);

    const tmpDir = mkdtempSync(join(tmpdir(), "acpus-fanout-queued-"));
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    const store = new RunStore(tmpDir);
    const interpreter = new WorkflowInterpreter(store, new StubAgentExecutor({}), new ItemProgramExecutor(), {
      maxConcurrency: 10,
      nowTimestamp: "2025-01-01T00:00:00Z"
    });

    const meta = await interpreter.start(ir, { input: { items: ["boom", "slow", "queued"] } });
    expect(meta.status).toBe("failed");

    const states = store.listNodeStates(meta.runId);
    const workNodes = states.filter((n) => n.nodeId === "work");
    expect(workNodes).toHaveLength(2);
    expect(workNodes.find((n) => n.nodeKey.includes("lane:0"))?.state).toBe("failed");
    expect(workNodes.find((n) => n.nodeKey.includes("lane:1"))?.state).toBe("cancelled");
    expect(states.find((n) => n.kind === "pipeline" && n.nodeKey.includes("lane:2"))?.state).toBe("cancelled");
  });

  it("join: all fail-fast cancels repeated-dynamic descendants under subworkflow prefixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-fanout-subwf-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const childPath = join(dir, "child.yaml");
    writeFileSync(childPath, `
version: 1
name: child-fanout
workflow:
  steps:
    - id: child_mapped
      fanout:
        over: input.inner_items
        key: ${"${{ item }}"}
        join: all
        do:
          - id: child_slow
            run: program
            cmd: ["echo", "child-slow"]
`);

    const ir = compileYaml(`
version: 1
name: fanout-subworkflow-fail-fast
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        key: ${"\${{ item }}"}
        join: all
        do:
          - id: route
            switch:
              cases:
                - when: item == "boom"
                  do:
                    - id: boom
                      run: program
                      cmd:
                        - echo
                        - boom
              default:
                do:
                  - id: sub
                    subworkflow: ${childPath}
                    input:
                      inner_items: ${"\${{ input.inner_items }}"}
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        boom: { failureKind: "timeout", delay: 5 },
        child_slow: { stdout: "child-slow-out", delay: 300 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["slow", "boom"], inner_items: ["inner"] } });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.filter((n) => n.state === "running" || n.state === "pending" || n.state === "awaiting")).toEqual([]);

    const childSlow = nodes.find((n) => n.nodeId === "child_slow");
    expect(childSlow?.state).toBe("cancelled");
    expect(childSlow?.nodeKey).toContain("/route/");
    expect(childSlow?.nodeKey).toContain("/sub/");
    expect(childSlow?.nodeKey).toContain("item:slow/lane:0");
    expect(childSlow?.nodeKey).toContain("item:inner/lane:0");
  });

  it("fail-fast does NOT cancel nodes under a different outer lane with matching inner dimensions (B2)", async () => {
    // Two outer fanout lanes, each with a subworkflow containing an inner fanout
    // with identical item/lane values. When the inner lane under outer lane A
    // fails, the inner fail-fast cancellation must not cancel the matching
    // child_work under outer lane B.
    const dir = mkdtempSync(join(tmpdir(), "acpus-cross-lane-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const childAPath = join(dir, "child-a.yaml");
    const childBPath = join(dir, "child-b.yaml");
    const childSpec = `
version: 1
name: child-fanout
workflow:
  steps:
    - id: child_mapped
      fanout:
        over: input.inner_items
        key: \${{ item }}
        join: all
        do:
          - id: child_work
            run: program
            cmd: ["echo", "child-work"]
`;
    writeFileSync(childAPath, childSpec);
    writeFileSync(childBPath, childSpec);

    const ir = compileYaml(`
version: 1
name: cross-lane-boundary
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        key: \${{ item }}
        join: all
        success_criteria:
          min_success: 1
        do:
          - id: route
            switch:
              cases:
                - when: item == "a"
                  do:
                    - id: sub_a
                      subworkflow: ${childAPath}
                      input:
                        inner_items: \${{ input.inner_items }}
              default:
                do:
                  - id: sub_b
                    subworkflow: ${childBPath}
                    input:
                      inner_items: \${{ input.inner_items }}
`);

    const tmpDir = mkdtempSync(join(tmpdir(), "acpus-cross-lane-store-"));
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    const store = new RunStore(tmpDir);
    const interpreter = new WorkflowInterpreter(store, new StubAgentExecutor({}), new CrossLaneProgramExecutor(), {
      nowTimestamp: "2025-01-01T00:00:00Z"
    });

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"], inner_items: ["x"] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const childWorks = nodes.filter((n) => n.nodeId === "child_work");
    expect(childWorks).toHaveLength(2);

    const laneAChild = childWorks.find((n) => n.nodeKey.includes("item:a/"));
    expect(laneAChild?.state).toBe("failed");

    const laneBChild = childWorks.find((n) => n.nodeKey.includes("item:b/"));
    expect(laneBChild?.state).toBe("completed");
  });
});
