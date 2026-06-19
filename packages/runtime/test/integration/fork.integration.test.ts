import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { ForkError, materializeForkedRun, planForkedRun } from "../../src/fork.js";
import { applyAgentOverrides, parseWorkflowSpecForOverrides } from "@acpus/core";

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

const SPEC_WITH_INPUT_DEFAULT = [
  "version: 1",
  "name: fork-input-demo",
  "input:",
  "  branch?: string = \"inherited-default\"",
  "workflow:",
  "  steps:",
  "    - id: gather",
  "      run: program",
  "      cmd: [\"echo\", \"${{ input.branch }}\"]",
  "      capture:",
  "        from: stdout",
  "        parse: text"
].join("\n");

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
    expect(() => planForkedRun(store, { sourceRunId: meta.runId, ir })).toThrow(ForkError);
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
    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir: newIr });
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
    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir: newIr });

    // gather should inherit; build differs; publish must NOT inherit.
    expect(plan.inheritedNodeKeys).toContain("workflow/gather");
    expect(plan.inheritedNodeKeys).not.toContain("workflow/build");
    expect(plan.inheritedNodeKeys).not.toContain("workflow/publish");
    expect(plan.forkOriginNodeKey).toBe("workflow/build");
    expect(plan.boundaryReason).toBe("hash-mismatch");
  });

  it("does not inherit a workflow-context-dependent node when source dir changes", async () => {
    const sourceDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-fork-source-a-")));
    const forkDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-fork-source-b-")));
    cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(forkDir, { recursive: true, force: true }));

    const spec = `
version: 1
name: fork-workflow-context
workflow:
  steps:
    - id: locate
      run: program
      cmd: ["echo", "\${{ workflow.source_dir }}"]
      capture:
        from: stdout
        parse: text
    - id: publish
      run: program
      cmd: ["echo", "publish"]
`;
    const sourceIr = compileYaml(spec);
    sourceIr.source.path = join(sourceDir, "workflow.yaml");
    const forkIr = compileYaml(spec);
    forkIr.source.path = join(forkDir, "workflow.yaml");

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        locate: { parsedOutput: sourceDir },
        publish: {}
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(sourceIr, { input: {} });
    expect(meta.status).toBe("completed");

    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir: forkIr });

    expect(plan.inheritedNodeKeys).not.toContain("workflow/locate");
    expect(plan.inheritedNodeKeys).not.toContain("workflow/publish");
    expect(plan.forkOriginNodeKey).toBe("workflow/locate");
    expect(plan.boundaryReason).toBe("hash-mismatch");
  });

  it("still inherits workflow-independent nodes when only source dir changes", async () => {
    const sourceDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-fork-independent-a-")));
    const forkDir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-fork-independent-b-")));
    cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(forkDir, { recursive: true, force: true }));

    const spec = `
version: 1
name: fork-workflow-independent
workflow:
  steps:
    - id: build
      run: program
      cmd: ["echo", "stable"]
`;
    const sourceIr = compileYaml(spec);
    sourceIr.source.path = join(sourceDir, "workflow.yaml");
    const forkIr = compileYaml(spec);
    forkIr.source.path = join(forkDir, "workflow.yaml");

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { build: { parsedOutput: "stable" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(sourceIr, { input: {} });
    expect(meta.status).toBe("completed");

    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir: forkIr });

    expect(plan.inheritedNodeKeys).toContain("workflow/build");
    expect(plan.boundaryReason).toBe("all-completed");
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
      planForkedRun(store, {
        sourceRunId: meta.runId,
        ir,
        overrideOriginNodeKey: "workflow/per_file/process"
      })
    ).toThrow(ForkError);
  });

  it("materializeForkedRun inherits source input and persists immediate lineage", async () => {
    const ir = compileYaml(SPEC_WITH_INPUT_DEFAULT);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "source" }
      }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: { branch: "source" } });
    expect(sourceMeta.status).toBe("completed");

    const materialized = materializeForkedRun(store, {
      sourceRunId: sourceMeta.runId,
      forkRunId: "fork-run-input-inherited",
      ir
    });
    const plan = materialized.plan;

    expect(materialized.input).toEqual({ branch: "source" });
    expect(store.readInput("fork-run-input-inherited")).toEqual({ branch: "source" });
    expect(store.readRunMeta("fork-run-input-inherited")?.lineage).toEqual({
      sourceRunId: sourceMeta.runId,
      forkOriginNodeKey: plan.forkOriginNodeKey,
      inheritedNodeCount: plan.inheritedNodeKeys.length
    });
  });

  it("materializeForkedRun validates and persists explicit input overrides", async () => {
    const ir = compileYaml(SPEC_WITH_INPUT_DEFAULT);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        gather: { parsedOutput: "source" }
      }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: { branch: "source" } });
    expect(sourceMeta.status).toBe("completed");

    const materialized = materializeForkedRun(store, {
      sourceRunId: sourceMeta.runId,
      forkRunId: "fork-run-input-override",
      ir,
      input: {}
    });

    expect(materialized.input).toEqual({ branch: "inherited-default" });
    expect(store.readInput("fork-run-input-override")).toEqual({ branch: "inherited-default" });
  });

  it("materializeForkedRun copies inherited node state and rewrites artifact URIs", async () => {
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
    const forkRunId = "fork-run-1";
    materializeForkedRun(store, { sourceRunId: sourceMeta.runId, forkRunId, ir });

    const inheritedBuild = store.readNodeState(forkRunId, "workflow/build");
    expect(inheritedBuild?.state).toBe("completed");
    expect(inheritedBuild?.artifactRefs?.length).toBeGreaterThan(0);
    expect(inheritedBuild?.artifactRefs?.every((uri) => uri.includes(`artifact://runs/${forkRunId}/`))).toBe(true);
    expect(inheritedBuild?.artifactRefs?.some((uri) => uri.includes(`artifact://runs/${sourceMeta.runId}/`))).toBe(false);
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
    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir });
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
    const plan = planForkedRun(store, {
      sourceRunId: meta.runId,
      ir,
      overrideOriginNodeKey: "workflow/build"
    });
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
    const round1Idx = checkpoints.findIndex((c) => c.nodeKey.endsWith("/tally/round:1"));
    expect(round1Idx).toBeGreaterThanOrEqual(0);
    const synthetic = checkpoints.map((c, i) => i === round1Idx ? { ...c, state: "failed" as const } : c);

    store.appendCheckpoint(meta.runId, {
      nodeKey: synthetic[round1Idx]!.nodeKey,
      state: "failed",
      definitionHash: synthetic[round1Idx]!.definitionHash,
      completedAt: synthetic[round1Idx]!.completedAt
    });

    const plan = planForkedRun(store, { sourceRunId: meta.runId, ir });
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

    const forkAId = "fork-a";
    materializeForkedRun(store, { sourceRunId: sourceMeta.runId, forkRunId: forkAId, ir });
    const metaA = store.readRunMeta(forkAId)!;
    metaA.status = "completed";
    store.writeRunMeta(forkAId, metaA);

    const planB = planForkedRun(store, { sourceRunId: forkAId, ir });
    expect(planB.sourceRunId).toBe(forkAId);
    const forkBId = "fork-b";
    materializeForkedRun(store, { sourceRunId: forkAId, forkRunId: forkBId, ir, plan: planB });
    const finalB = store.readRunMeta(forkBId)!;
    expect(finalB.lineage?.sourceRunId).toBe(forkAId);
    expect(finalB.lineage?.sourceRunId).not.toBe(sourceMeta.runId);
  });

  it("fork-of-fork preserves the persisted single-layer Agent Override map", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: {} });

    const forkAId = "fork-agent-a";
    materializeForkedRun(store, {
      sourceRunId: sourceMeta.runId,
      forkRunId: forkAId,
      ir,
      agentOverrides: {
        reviewer: { type: "builtin", use: "pi", model: "deepseek" },
        cross_examiner: { type: "builtin", use: "claude" }
      }
    });
    const metaA = store.readRunMeta(forkAId)!;
    metaA.status = "completed";
    store.writeRunMeta(forkAId, metaA);

    const inherited = store.readRunMeta(forkAId)?.agentOverrides ?? {};
    const result = applyAgentOverrides(parseWorkflowSpecForOverrides([
      "version: 1",
      "name: fork-agent-overrides",
      "agents:",
      "  reviewer:",
      "    type: builtin",
      "    use: codex",
      "  cross_examiner:",
      "    type: builtin",
      "    use: pi",
      "workflow:",
      "  steps:",
      "    - id: impl",
      "      run: agent",
      "      use: reviewer",
      "      prompt: Do it."
    ].join("\n")), undefined, { inherited });

    const forkBId = "fork-agent-b";
    materializeForkedRun(store, {
      sourceRunId: forkAId,
      forkRunId: forkBId,
      ir,
      agentOverrides: result.agentOverrides
    });

    expect(store.readRunMeta(forkBId)?.agentOverrides).toEqual({
      reviewer: { type: "builtin", use: "pi", model: "deepseek" },
      cross_examiner: { type: "builtin", use: "claude" }
    });
  });

  it("materializeForkedRun persists effective single-layer Agent Overrides and warnings", async () => {
    const ir = compileYaml(SPEC_V1);
    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { gather: { parsedOutput: "hi" }, build: {}, publish: {} }
    });
    cleanups.push(cleanup);
    const sourceMeta = await interpreter.start(ir, { input: {} });

    const warnings = [{ code: "AGENT_MODEL_CLEARED" as const, agent: "implementer", message: "cleared" }];
    materializeForkedRun(store, {
      sourceRunId: sourceMeta.runId,
      forkRunId: "fork-with-agent-overrides",
      ir,
      agentOverrides: { implementer: { type: "builtin", use: "codex" } },
      submissionWarnings: warnings
    });

    expect(store.readRunMeta("fork-with-agent-overrides")?.agentOverrides).toEqual({
      implementer: { type: "builtin", use: "codex" }
    });
    expect(store.readRunMeta("fork-with-agent-overrides")?.submissionWarnings).toEqual(warnings);
  });

  it("fork override merge inherits source effective map and lets current overrides win", () => {
    const source = [
      "version: 1",
      "name: fork-agent-overrides",
      "agents:",
      "  implementer:",
      "    type: builtin",
      "    use: codex",
      "    model: gpt-5",
      "  reviewer:",
      "    type: builtin",
      "    use: claude",
      "workflow:",
      "  steps:",
      "    - id: impl",
      "      run: agent",
      "      use: implementer",
      "      prompt: Do it."
    ].join("\n");

    const result = applyAgentOverrides(parseWorkflowSpecForOverrides(source), {
      reviewer: { model: "opus" }
    }, {
      inherited: {
        implementer: { model: "gpt-5.1" }
      }
    });

    expect(result.agentOverrides).toEqual({
      implementer: { model: "gpt-5.1" },
      reviewer: { model: "opus" }
    });
    expect(result.effectiveSpec.agents?.implementer.model).toBe("gpt-5.1");
    expect(result.effectiveSpec.agents?.reviewer.model).toBe("opus");
  });
});
