import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { compileYaml, createTestInterpreter } from "./interpreter/helper.js";
import { applyFork, ForkError, planFork } from "../src/fork.js";

const SPEC_V1 = `
version: 1
name: fork-demo
workflow:
  steps:
    - id: gather
      run: program
      cmd: ["echo", "hello"]
      capture:
        from: stdout
        parse: text
    - id: build
      run: program
      cmd: ["bash", "-c", "true"]
    - id: publish
      run: program
      cmd: ["echo", "publish"]
`;

const SPEC_V2_SAME = SPEC_V1;

const SPEC_V2_BUILD_CHANGED = `
version: 1
name: fork-demo
workflow:
  steps:
    - id: gather
      run: program
      cmd: ["echo", "hello"]
      capture:
        from: stdout
        parse: text
    - id: build
      run: program
      cmd: ["bash", "-c", "echo 'fixed'"]
    - id: publish
      run: program
      cmd: ["echo", "publish"]
`;

describe("Forked Run", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("rejects fork from a non-terminal source Run", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "hello" },
        build: {},
        publish: {}
      }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    // Pretend this Run is still running for the test.
    const live = store.readRunMeta(meta.runId)!;
    live.status = "running";
    store.writeRunMeta(meta.runId, live);
    const checkpoints = store.readCheckpoints(meta.runId);
    expect(() => planFork(live, checkpoints, ir)).toThrow(ForkError);
  });

  it("inherits all completed nodes when the new Spec is identical", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "hello" },
        build: {},
        publish: {}
      }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const checkpoints = store.readCheckpoints(meta.runId);
    expect(checkpoints.length).toBeGreaterThan(0);

    const newIr = compileYaml(SPEC_V2_SAME);
    const plan = planFork(store.readRunMeta(meta.runId)!, checkpoints, newIr);
    // All program steps are inherited; root pipeline is NOT a checkpointable
    // kind, so it is absent from inheritance (F1 regression).
    expect(plan.inheritedNodeKeys).toContain("workflow/gather");
    expect(plan.inheritedNodeKeys).toContain("workflow/build");
    expect(plan.inheritedNodeKeys).toContain("workflow/publish");
    expect(plan.inheritedNodeKeys).not.toContain("workflow");
    expect(plan.boundaryReason).toBe("all-completed");
  });

  it("truncates inheritance at the first hash mismatch", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "hello" },
        build: { exitCode: 1 }, // would normally fail; we force completion
        publish: {}
      }
    });
    cleanups.push(cleanup);
    // Provide an `expect: [0,1]` so build completes; exercise hash mismatch path.
    const irWithExpect = compileYaml(`
version: 1
name: fork-demo
workflow:
  steps:
    - id: gather
      run: program
      cmd: ["echo", "hello"]
      capture:
        from: stdout
        parse: text
    - id: build
      run: program
      cmd: ["bash", "-c", "true"]
      expect:
        exit_code: [0, 1]
    - id: publish
      run: program
      cmd: ["echo", "publish"]
`);
    const meta = await interpreter.start(irWithExpect, { input: {} });
    expect(meta.status).toBe("completed");

    const checkpoints = store.readCheckpoints(meta.runId);
    const newIr = compileYaml(SPEC_V2_BUILD_CHANGED);
    const plan = planFork(store.readRunMeta(meta.runId)!, checkpoints, newIr);

    // gather should inherit; build differs; publish must NOT inherit.
    expect(plan.inheritedNodeKeys).toContain("workflow/gather");
    expect(plan.inheritedNodeKeys).not.toContain("workflow/build");
    expect(plan.inheritedNodeKeys).not.toContain("workflow/publish");
    expect(plan.forkOriginNodeKey).toBe("workflow/build");
    expect(plan.boundaryReason).toBe("hash-mismatch");
  });

  it("rejects an operator override targeting a Composite-body Node", async () => {
    const ir = compileYaml([
      "version: 1",
      "name: fanout-demo",
      "workflow:",
      "  steps:",
      "    - id: gather",
      "      run: program",
      "      cmd: [\"echo\", \"ok\"]",
      "      capture: { from: stdout, parse: text }",
      "    - id: per_file",
      "      fanout:",
      "        over: '[\"a\",\"b\"]'",
      "        do:",
      "          - id: process",
      "            run: program",
      "            cmd: [\"echo\", \"item-output\"]"
    ].join("\n"));
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "ok" },
        process: { parsedOutput: "out" }
      }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const checkpoints = store.readCheckpoints(meta.runId);
    expect(() =>
      planFork(store.readRunMeta(meta.runId)!, checkpoints, ir, "workflow/per_file/process")
    ).toThrow(ForkError);
  });

  it("applyFork copies inherited node state and artifacts into the new Run", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "hello", stdout: "hello", stderr: "" },
        build: { stdout: "built", stderr: "" },
        publish: { stdout: "published", stderr: "" }
      }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: {} });
    expect(sourceMeta.status).toBe("completed");

    const checkpoints = store.readCheckpoints(sourceMeta.runId);
    const plan = planFork(store.readRunMeta(sourceMeta.runId)!, checkpoints, ir);

    // Initialize the fork Run, then apply.
    const forkRunId = "fork-run-1";
    store.initRun(forkRunId, ir, {});
    applyFork(store, forkRunId, plan);

    const inheritedBuild = store.readNodeState(forkRunId, "workflow/build");
    expect(inheritedBuild?.state).toBe("completed");
    // Artifact directory must exist for the fork Run.
    const buildArtifactDir = store.artifactsDir(forkRunId, "workflow/build");
    expect(existsSync(buildArtifactDir)).toBe(true);
  });

  it("operator override defaults to the inheritance boundary when omitted", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    const checkpoints = store.readCheckpoints(meta.runId);
    const plan = planFork(store.readRunMeta(meta.runId)!, checkpoints, ir);
    expect(plan.forkOriginNodeKey).toBe(plan.defaultForkOriginNodeKey);
  });

  it("does not write checkpoints for container Nodes (F1 regression)", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    const checkpoints = store.readCheckpoints(meta.runId);
    expect(checkpoints.find((c) => c.nodeKey === "workflow")).toBeUndefined();
    for (const cp of checkpoints) {
      expect(["workflow/gather", "workflow/build", "workflow/publish"]).toContain(cp.nodeKey);
    }
  });

  it("override at `build` drops later siblings like `publish` (F2 regression)", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    const checkpoints = store.readCheckpoints(meta.runId);
    const plan = planFork(store.readRunMeta(meta.runId)!, checkpoints, ir, "workflow/build");
    expect(plan.inheritedNodeKeys).toEqual(["workflow/gather"]);
    expect(plan.forkOriginNodeKey).toBe("workflow/build");
    expect(plan.boundaryReason).toBe("operator-override");
  });

  it("`expect: { exit_code: [0] }` is hash-stable with omitted expect (F7 regression)", () => {
    const irOmitted = compileYaml(`
version: 1
name: hash-stable
workflow:
  steps:
    - id: build
      run: program
      cmd: ["bash", "-c", "true"]
`);
    const irExplicit = compileYaml(`
version: 1
name: hash-stable
workflow:
  steps:
    - id: build
      run: program
      cmd: ["bash", "-c", "true"]
      expect:
        exit_code: [0]
`);
    const omittedNode = irOmitted.root.children![0];
    const explicitNode = irExplicit.root.children![0];
    expect(JSON.stringify(omittedNode.metadata)).toBe(JSON.stringify(explicitNode.metadata));
  });

  it("default Fork Origin is lifted out of Composite bodies", async () => {
    // Loop body fails on round 1 — the checkpoint Node Key would point inside
    // the loop's body. The default Fork Origin must be lifted up to the loop
    // Composite itself (which is a valid override target), mirroring the
    // constraint enforced on operator overrides.
    const ir = compileYaml([
      "version: 1",
      "name: lift-loop",
      "workflow:",
      "  steps:",
      "    - id: aggregate",
      "      loop:",
      "        max_iterations: 2",
      "        do:",
      "          - id: tally",
      "            run: program",
      "            cmd: [\"bash\", \"-c\", \"echo r-${{ loop.iter }}\"]",
      "            capture: { from: stdout, parse: text }",
      "    - id: publish",
      "      run: program",
      "      cmd: [\"bash\", \"-c\", \"echo published\"]",
      "      capture: { from: stdout, parse: text }"
    ].join("\n"));

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        tally: { parsedOutput: "ok" },
        publish: { parsedOutput: "ok" }
      }
    });
    cleanups.push(cleanup);
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    // Mutate the second tally checkpoint to simulate a round-1 failure.
    const checkpoints = store.readCheckpoints(meta.runId);
    const round1Idx = checkpoints.findIndex((c) => c.nodeKey === "workflow/aggregate/tally/round:1");
    expect(round1Idx).toBeGreaterThanOrEqual(0);
    const synthetic = checkpoints.map((c, i) => i === round1Idx ? { ...c, state: "failed" as const } : c);

    const plan = planFork(store.readRunMeta(meta.runId)!, synthetic, ir);
    expect(plan.boundaryReason).toBe("non-completed");
    // BEFORE lift fix: this would have been "workflow/aggregate/tally/round:1"
    // (inside the loop body — invalid as a Fork Origin).
    expect(plan.defaultForkOriginNodeKey).toBe("workflow/aggregate");
    expect(plan.forkOriginNodeKey).toBe("workflow/aggregate");
  });

  it("fork-of-fork lineage records only the immediate prior Run (F9 regression)", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: {} });

    const checkpointsA = store.readCheckpoints(sourceMeta.runId);
    const planA = planFork(store.readRunMeta(sourceMeta.runId)!, checkpointsA, ir);
    const forkAId = "fork-a";
    store.initRun(forkAId, ir, {});
    applyFork(store, forkAId, planA);
    const metaA = store.readRunMeta(forkAId)!;
    metaA.lineage = {
      sourceRunId: planA.sourceRunId,
      forkOriginNodeKey: planA.forkOriginNodeKey,
      inheritedNodeCount: planA.inheritedNodeKeys.length
    };
    metaA.status = "completed";
    store.writeRunMeta(forkAId, metaA);

    const checkpointsB = store.readCheckpoints(forkAId);
    const planB = planFork(store.readRunMeta(forkAId)!, checkpointsB, ir);
    expect(planB.sourceRunId).toBe(forkAId);
    const forkBId = "fork-b";
    store.initRun(forkBId, ir, {});
    applyFork(store, forkBId, planB);
    const metaB = store.readRunMeta(forkBId)!;
    metaB.lineage = {
      sourceRunId: planB.sourceRunId,
      forkOriginNodeKey: planB.forkOriginNodeKey,
      inheritedNodeCount: planB.inheritedNodeKeys.length
    };
    store.writeRunMeta(forkBId, metaB);
    const finalB = store.readRunMeta(forkBId)!;
    expect(finalB.lineage?.sourceRunId).toBe(forkAId);
    expect(finalB.lineage?.sourceRunId).not.toBe(sourceMeta.runId);
  });
});
