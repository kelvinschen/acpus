import type { ExprIR, JsonPrimitive, JsonValue, WorkflowIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { planForkReplay, type ForkReplayPlanFact } from "../src/scheduler/fork-replay-plan.js";
import { isReplayLeaf, replayIdentity } from "../src/scheduler/fork-replay.js";
import { indexNodes } from "../src/scheduler/ir-walk.js";
import { bootstrapRootEvents } from "../src/scheduler/materialize.js";
import { scopeForNodeAttempt } from "../src/scheduler/scope.js";
import { frozenRunScope, settleFrozenProjection, type FrozenSchedulerRun } from "../src/scheduler/settle.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { SchedulerProjection } from "../src/scheduler/types.js";

const noArtifact = () => undefined;

describe("fork replay session-group plan", () => {
  it("plans every member together and drops every member at an intersecting checkpoint", () => {
    const source = completeSource(sessionWorkflow());

    const complete = plan(source, source.facts);
    const intersecting = plan(source, source.facts.slice(0, 1));

    expect(complete.sessionGroups).toEqual([
      { sessionGroupDigest: source.facts[0]!.sessionGroupDigest, memberCount: 2 },
    ]);
    expect(complete.facts.map(fact => fact.nodeKey)).toEqual(source.facts.map(fact => fact.nodeKey));
    expect(intersecting).toEqual({ facts: [], sessionGroups: [] });
  });

  it("drops the whole group when one child member changes", () => {
    const source = completeSource(sessionWorkflow());
    const changed = sessionWorkflow();
    const second = changed.ir.root.nodes[1];
    if (second?.kind !== "agent") throw new Error("expected second agent");
    second.run.prompt = literal("changed");

    expect(planForkReplay({
      source: { frozen: source.frozen, projection: source.projection, artifactDigest: noArtifact },
      child: { runId: "child", frozen: changed, artifactDigest: noArtifact },
      facts: source.facts,
    })).toEqual({ facts: [], sessionGroups: [] });
  });

  it("reruns conservatively when an unmaterialized dynamic key could alias the group", () => {
    const source = completeSource(sessionWorkflow({ laterSessionKey: ref("nodes", "barrier", "output", "key") }));
    const beforeBarrier = source.facts.slice(0, 2);

    expect(plan(source, beforeBarrier)).toEqual({ facts: [], sessionGroups: [] });
  });

  it("keeps a closed group when a later key is provably different", () => {
    const source = completeSource(sessionWorkflow({ laterSessionKey: ref("input", "laterKey"), input: { laterKey: "other" } }));
    const beforeBarrier = source.facts.slice(0, 2);
    const replay = plan(source, beforeBarrier);

    expect(replay.sessionGroups).toHaveLength(1);
    expect(replay.sessionGroups[0]).toMatchObject({ memberCount: 2 });
    expect(replay.facts.map(fact => fact.nodeKey)).toEqual(beforeBarrier.map(fact => fact.nodeKey));
  });
});

function plan(source: CompletedSource, facts: ForkReplayPlanFact[]) {
  return planForkReplay({
    source: { frozen: source.frozen, projection: source.projection, artifactDigest: noArtifact },
    child: {
      runId: "child",
      frozen: { ...source.frozen, meta: { ...source.frozen.meta, runId: "child" } },
      artifactDigest: noArtifact,
    },
    facts,
  });
}

type CompletedSource = {
  frozen: FrozenSchedulerRun;
  projection: SchedulerProjection;
  facts: ForkReplayPlanFact[];
};

function completeSource(frozen: FrozenSchedulerRun): CompletedSource {
  const scope = frozenRunScope(frozen);
  const nodes = indexNodes(frozen.ir.root);
  let projection = settleFrozenProjection({
    frozen,
    projection: createSchedulerProjection("source"),
    initialEvents: bootstrapRootEvents("source", frozen.ir, scope),
    now: new Date(0),
  }).projection;
  const facts: ForkReplayPlanFact[] = [];
  for (let sequence = 1; sequence < 20; sequence += 1) {
    const instance = Object.values(projection.instances).find(candidate => candidate.status === "ready");
    if (!instance) break;
    const node = nodes.get(instance.nodeId);
    if (!node || !isReplayLeaf(node)) throw new Error(`missing replay leaf '${instance.nodeId}'`);
    const identity = replayIdentity(
      node,
      scopeForNodeAttempt(scope, projection, instance.nodeKey),
      node.kind === "agent" ? frozen.ir.agents[node.run.agent] : undefined,
      noArtifact,
    );
    if (!identity) throw new Error(`missing replay identity '${instance.nodeId}'`);
    const output = outputFor(instance.nodeId);
    facts.push({ nodeKey: instance.nodeKey, sourceSequence: sequence, ...identity, output });
    projection = settleFrozenProjection({
      frozen,
      projection: applySchedulerEvents(projection, [{
        type: "instance.completed",
        payload: { nodeKey: instance.nodeKey, output, replayIdentity: identity },
      }]),
      now: new Date(0),
    }).projection;
  }
  expect(projection.run.status).toBe("completed");
  return { frozen, projection, facts };
}

function sessionWorkflow(options: { laterSessionKey?: ExprIR; input?: JsonValue } = {}): FrozenSchedulerRun {
  const nodes: WorkflowIR["root"]["nodes"] = [
    agent("first", literal("shared"), literal("first")),
    agent("second", literal("shared"), ref("nodes", "first", "output", "ok")),
  ];
  if (options.laterSessionKey) {
    nodes.push({
      id: "barrier",
      kind: "task",
      run: {
        input: literal(null),
        target: { kind: "inline", source: "async () => ({ key: 'other' })" },
      },
    });
    nodes.push(agent("later", options.laterSessionKey, literal("later")));
  }
  return {
    ir: {
      irVersion: 7,
      name: "session-group-plan",
      agents: { reviewer: { kind: "agent_definition", use: "codex" } },
      root: { nodes, output: literal(null) },
      diagnostics: [],
    },
    input: options.input ?? {},
    meta: { runId: "source", workflowName: "session-group-plan" },
  };
}

function agent(id: string, sessionKey: ExprIR, prompt: ExprIR): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "agent",
    run: { agent: "reviewer", sessionKey, prompt },
  };
}

function outputFor(nodeId: string): JsonValue {
  if (nodeId === "barrier") return { key: "other" };
  return { ok: true };
}

function literal(value: JsonPrimitive): ExprIR {
  return { kind: "literal", value };
}

function ref(...path: string[]): ExprIR {
  return { kind: "ref", path };
}
