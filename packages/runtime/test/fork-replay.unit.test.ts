import type { AgentDefinitionIR, AgentNodeIR, TaskNodeIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { replayEvaluation, replayIdentity } from "../src/scheduler/fork-replay.js";

const noArtifact = () => undefined;

describe("fork replay identity", () => {
  it("depends only on fields declared by the leaf", () => {
    const node = task(["input", "a"]);
    const original = replayIdentity(node, { input: { a: 1, b: "old" } }, undefined, noArtifact);
    const unrelatedChange = replayIdentity(node, { input: { a: 1, b: "new" } }, undefined, noArtifact);
    const declaredChange = replayIdentity(node, { input: { a: 2, b: "old" } }, undefined, noArtifact);

    expect(unrelatedChange).toEqual(original);
    expect(declaredChange?.operationDigest).toBe(original?.operationDigest);
    expect(declaredChange?.inputDigest).not.toBe(original?.inputDigest);
  });

  it("treats the leaf operation as part of compatibility", () => {
    const original = replayIdentity(task(["input", "a"]), { input: { a: 1 } }, undefined, noArtifact);
    const changedNode = {
      ...task(["input", "a"]),
      run: { ...task(["input", "a"]).run, target: { kind: "inline", source: "async () => 'changed'" } },
    } satisfies TaskNodeIR;
    const changed = replayIdentity(changedNode, { input: { a: 1 } }, undefined, noArtifact);

    expect(changed?.operationDigest).not.toBe(original?.operationDigest);
    expect(changed?.inputDigest).toBe(original?.inputDigest);
  });

  it("allows downstream reuse when a rerun produces the same logical value", () => {
    const node = task(["nodes", "prepare", "output"]);
    const original = replayIdentity(node, { nodes: { prepare: { output: { value: 1 } } } }, undefined, noArtifact);
    const sameOutput = replayIdentity(node, { nodes: { prepare: { output: { value: 1 } } } }, undefined, noArtifact);
    const changedOutput = replayIdentity(node, { nodes: { prepare: { output: { value: 2 } } } }, undefined, noArtifact);

    expect(sameOutput).toEqual(original);
    expect(changedOutput?.inputDigest).not.toBe(original?.inputDigest);
  });

  it("compares artifact inputs by content digest and refuses missing artifacts", () => {
    const node = task(["input", "artifact"]);
    const source = replayIdentity(node, {
      input: { artifact: { kind: "artifact", uri: "artifact://source/a" } },
    }, undefined, uri => uri === "artifact://source/a" ? "sha256:same" : undefined);
    const fork = replayIdentity(node, {
      input: { artifact: { kind: "artifact", uri: "artifact://fork/b" } },
    }, undefined, uri => uri === "artifact://fork/b" ? "sha256:same" : undefined);
    const changed = replayIdentity(node, {
      input: { artifact: { kind: "artifact", uri: "artifact://fork/c" } },
    }, undefined, () => "sha256:different");

    expect(fork).toEqual(source);
    expect(changed?.inputDigest).not.toBe(source?.inputDigest);
    expect(replayIdentity(node, {
      input: { artifact: { kind: "artifact", uri: "artifact://missing/a" } },
    }, undefined, noArtifact)).toBeUndefined();
  });

  it("includes referenced run metadata in the input identity", () => {
    const node = task(["meta", "runId"]);
    const source = replayIdentity(node, { meta: { runId: "source" } }, undefined, noArtifact);
    const fork = replayIdentity(node, { meta: { runId: "fork" } }, undefined, noArtifact);

    expect(fork?.inputDigest).not.toBe(source?.inputDigest);
  });

  it("assigns explicit-session agents a run-independent session group", () => {
    const definition: AgentDefinitionIR = { kind: "agent_definition", use: "codex" };
    const first = replayIdentity(agent({ kind: "literal", value: "shared" }), {}, definition, noArtifact);
    const same = replayIdentity(agent({ kind: "literal", value: "shared" }), {}, definition, noArtifact);
    const different = replayIdentity(agent({ kind: "literal", value: "other" }), {}, definition, noArtifact);

    expect(first?.sessionGroupDigest).toMatch(/^sha256:/);
    expect(same?.sessionGroupDigest).toBe(first?.sessionGroupDigest);
    expect(different?.sessionGroupDigest).not.toBe(first?.sessionGroupDigest);

    const reusable = replayIdentity(agent(), {}, definition, noArtifact);
    const changedDefinition = replayIdentity(agent(), {}, { ...definition, model: "different" }, noArtifact);
    expect(reusable).toBeDefined();
    expect(reusable?.sessionGroupDigest).toBeUndefined();
    expect(changedDefinition?.operationDigest).not.toBe(reusable?.operationDigest);
  });

  it("resolves the session-group guard when another dependency prevents a full identity", () => {
    const definition: AgentDefinitionIR = { kind: "agent_definition", use: "codex" };
    const node = agent({ kind: "literal", value: "shared" });
    node.run.prompt = { kind: "ref", path: ["input", "payload"] };

    const replay = replayEvaluation(node, {
      input: { payload: { nested: { kind: "artifact", uri: "artifact://missing/a" } } },
    }, definition, noArtifact);

    expect(replay.replayIdentity).toBeUndefined();
    expect(replay.sessionGroupDigest).toMatch(/^sha256:/);
  });
});

function task(path: string[]): TaskNodeIR {
  return {
    id: "work",
    kind: "task",
    run: {
      input: { kind: "ref", path },
      target: { kind: "inline", source: "async () => 'ok'" },
    },
  };
}

function agent(sessionKey?: AgentNodeIR["run"]["sessionKey"]): AgentNodeIR {
  return {
    id: "review",
    kind: "agent",
    run: {
      agent: "reviewer",
      prompt: { kind: "literal", value: "Review" },
      ...(sessionKey === undefined ? {} : { sessionKey }),
    },
  };
}
