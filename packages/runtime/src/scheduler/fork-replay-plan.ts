import { walkNodes, type AgentNodeIR, type NodeChildScope } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { resolveAgentSessionGroupDigest } from "../execution/agent-session.js";
import { replayEvaluation } from "./fork-replay.js";
import { appendBranch, appendNode, deriveInstanceKey } from "./identity.js";
import { indexNodes } from "./ir-walk.js";
import { bootstrapRootEvents } from "./materialize.js";
import { completedScopeForFrame } from "./scope.js";
import { frozenRunScope, settleFrozenProjection, type FrozenSchedulerRun } from "./settle.js";
import { applySchedulerEvents, createSchedulerProjection } from "./transitions.js";
import type { SchedulerEvent } from "./events.js";
import type { InstancePath, ReplayIdentity, SchedulerProjection } from "./types.js";

export type ForkReplayPlanFact = {
  nodeKey: string;
  sourceSequence: number;
  operationDigest: string;
  inputDigest: string;
  sessionGroupDigest?: string;
  output?: JsonValue;
};

export type ForkReplaySessionGroup = {
  sessionGroupDigest: string;
  memberCount: number;
};

export function planForkReplay<T extends ForkReplayPlanFact>(input: {
  source: {
    frozen: FrozenSchedulerRun;
    projection: SchedulerProjection;
    artifactDigest: (uri: string) => string | undefined;
  };
  child: {
    runId: string;
    frozen: FrozenSchedulerRun;
    artifactDigest: (uri: string) => string | undefined;
  };
  facts: readonly T[];
}): { facts: T[]; sessionGroups: ForkReplaySessionGroup[] } {
  const factsByNode = new Map(input.facts.map(fact => [fact.nodeKey, fact]));
  const sourceTopology = sessionTopology(input.source.frozen, input.source.projection, input.source.artifactDigest);
  let eligible = new Set<string>();
  if (!sourceTopology.unknownPotential) {
    for (const [digest, members] of sourceTopology.members) {
      if (sourceTopology.potentialDigests.has(digest)) continue;
      if (members.every(member => {
        const fact = factsByNode.get(member.nodeKey);
        return fact?.sessionGroupDigest === digest && sameIdentity(fact, member.identity);
      })) eligible.add(digest);
    }
  }

  for (;;) {
    const simulated = simulateReplay(input.child, input.facts, eligible);
    const childTopology = sessionTopology(input.child.frozen, simulated.projection, input.child.artifactDigest);
    const next = new Set<string>();
    for (const digest of eligible) {
      if (childTopology.unknownPotential || childTopology.potentialDigests.has(digest)) continue;
      const sourceMembers = sourceTopology.members.get(digest) ?? [];
      const childMembers = childTopology.members.get(digest) ?? [];
      const sourceKeys = sourceMembers.map(member => member.nodeKey).sort();
      const childKeys = childMembers.map(member => member.nodeKey).sort();
      const sourceOrder = sourceMembers
        .map(member => factsByNode.get(member.nodeKey)!)
        .sort((left, right) => left.sourceSequence - right.sourceSequence || left.nodeKey.localeCompare(right.nodeKey))
        .map(fact => fact.nodeKey);
      if (sameArray(sourceKeys, childKeys)
        && sameArray(sourceOrder, simulated.sessionOrder.get(digest) ?? [])) next.add(digest);
    }
    if (sameSet(eligible, next)) break;
    eligible = next;
  }

  const sessionGroups = [...eligible]
    .sort()
    .map(sessionGroupDigest => ({
      sessionGroupDigest,
      memberCount: sourceTopology.members.get(sessionGroupDigest)!.length,
    }));
  return {
    facts: input.facts.filter(fact => fact.sessionGroupDigest === undefined || eligible.has(fact.sessionGroupDigest)),
    sessionGroups,
  };
}

type SessionMember = {
  nodeKey: string;
  identity: ReplayIdentity;
};

type SessionTopology = {
  members: Map<string, SessionMember[]>;
  potentialDigests: Set<string>;
  unknownPotential: boolean;
};

function sessionTopology(
  frozen: FrozenSchedulerRun,
  projection: SchedulerProjection,
  artifactDigest: (uri: string) => string | undefined,
): SessionTopology {
  const nodes = indexNodes(frozen.ir.root);
  const baseScope = frozenRunScope(frozen);
  const members = new Map<string, SessionMember[]>();
  let unknownPotential = false;
  for (const instance of Object.values(projection.instances)) {
    const node = nodes.get(instance.nodeId);
    if (node?.kind !== "agent" || node.run.sessionKey === undefined) continue;
    const identity = instance.replayIdentity ?? ((instance.status === "pending" || instance.status === "ready")
      ? replayEvaluation(
        node,
        completedScopeForFrame(projection, instance.parentFrameKey ?? "root", baseScope),
        frozen.ir.agents[node.run.agent],
        artifactDigest,
      ).replayIdentity
      : undefined);
    if (!identity?.sessionGroupDigest) {
      unknownPotential = true;
      continue;
    }
    const group = members.get(identity.sessionGroupDigest) ?? [];
    group.push({ nodeKey: instance.nodeKey, identity });
    members.set(identity.sessionGroupDigest, group);
  }

  const potentialDigests = new Set<string>();
  for (const visit of walkNodes(frozen.ir.root)) {
    if (visit.node.kind !== "agent" || visit.node.run.sessionKey === undefined) continue;
    for (const scope of potentialScopes(visit.node, visit.ancestry, frozen, projection)) {
      const digest = resolveAgentSessionGroupDigest(visit.node, scope);
      if (digest.isErr() || digest.value === undefined) unknownPotential = true;
      else potentialDigests.add(digest.value);
    }
  }
  return { members, potentialDigests, unknownPotential };
}

type AuthoredContext = {
  basePath: InstancePath;
  frameKey: string;
};

function potentialScopes(
  node: AgentNodeIR,
  ancestry: readonly NodeChildScope[],
  frozen: FrozenSchedulerRun,
  projection: SchedulerProjection,
): EvaluationScope[] {
  const baseScope = frozenRunScope(frozen);
  let contexts: AuthoredContext[] = [{ basePath: [], frameKey: "root" }];
  const potentials: EvaluationScope[] = [];
  const potential = (context: AuthoredContext) => {
    const frame = projection.frames[context.frameKey];
    if (!frame) {
      if (context.frameKey === "root") potentials.push(baseScope);
      else throw new Error(`Fork replay topology references missing frame '${context.frameKey}'.`);
      return;
    }
    if (!terminalFrame(frame.status)) potentials.push(completedScopeForFrame(projection, context.frameKey, baseScope));
  };

  for (const child of ancestry) {
    const next: AuthoredContext[] = [];
    for (const context of contexts) {
      const ownerKey = deriveInstanceKey(appendNode(context.basePath, child.owner.id));
      const owner = projection.frames[ownerKey];
      if (!owner) {
        potential(context);
        continue;
      }
      if (child.kind === "if" || child.kind === "switch") {
        const branchId = projection.branchDecisions[ownerKey];
        if (branchId === undefined) {
          if (!terminalFrame(owner.status)) potential(context);
          continue;
        }
        if (branchId !== child.branchId) continue;
        const basePath = appendBranch(context.basePath, child.owner.id, child.branchId);
        const frameKey = deriveInstanceKey(basePath);
        if (!projection.frames[frameKey]) throw new Error(`Fork replay conditional branch references missing frame '${frameKey}'.`);
        next.push({ basePath, frameKey });
        continue;
      }
      if (child.kind === "parallel") {
        const basePath = appendBranch(context.basePath, child.owner.id, child.branchId);
        const frameKey = deriveInstanceKey(basePath);
        if (!projection.frames[frameKey]) {
          if (owner.status === "failed" || owner.status === "cancelled") continue;
          throw new Error(`Fork replay parallel branch references missing frame '${frameKey}'.`);
        }
        next.push({ basePath, frameKey });
        continue;
      }
      if (child.kind === "fanout") {
        const items = Object.values(projection.frames)
          .filter(frame => frame.parentFrameKey === ownerKey && frame.frameKind === "fanout_item" && frame.instancePath)
          .sort((left, right) => lastDynamicIndex(left.instancePath!) - lastDynamicIndex(right.instancePath!));
        for (const item of items) next.push({ basePath: item.instancePath!, frameKey: item.frameKey });
        continue;
      }
      const iterations = Object.values(projection.frames)
        .filter(frame => frame.parentFrameKey === ownerKey && frame.frameKind === "loop_iteration" && frame.instancePath)
        .sort((left, right) => lastDynamicIndex(left.instancePath!) - lastDynamicIndex(right.instancePath!));
      for (const iteration of iterations) next.push({ basePath: iteration.instancePath!, frameKey: iteration.frameKey });
      if (!terminalFrame(owner.status)) potentials.push(completedScopeForFrame(projection, context.frameKey, baseScope));
    }
    contexts = next;
  }

  for (const context of contexts) {
    const nodeKey = deriveInstanceKey(appendNode(context.basePath, node.id));
    if (!projection.instances[nodeKey]) potential(context);
  }
  return potentials;
}

function simulateReplay<T extends ForkReplayPlanFact>(
  child: {
    runId: string;
    frozen: FrozenSchedulerRun;
    artifactDigest: (uri: string) => string | undefined;
  },
  facts: readonly T[],
  eligibleGroups: ReadonlySet<string>,
): { projection: SchedulerProjection; sessionOrder: Map<string, string[]> } {
  const baseScope = frozenRunScope(child.frozen);
  const nodes = indexNodes(child.frozen.ir.root);
  const orderedFacts = [...facts].sort((left, right) => left.sourceSequence - right.sourceSequence || left.nodeKey.localeCompare(right.nodeKey));
  const applied = new Set<string>();
  const sessionOrder = new Map<string, string[]>();
  let projection = settleFrozenProjection({
    frozen: child.frozen,
    projection: createSchedulerProjection(child.runId),
    initialEvents: bootstrapRootEvents(child.runId, child.frozen.ir, baseScope),
    now: new Date(0),
  }).projection;

  for (;;) {
    const nextByGroup = new Map<string, string>();
    for (const fact of orderedFacts) {
      if (applied.has(fact.nodeKey)
        || fact.sessionGroupDigest === undefined
        || !eligibleGroups.has(fact.sessionGroupDigest)
        || nextByGroup.has(fact.sessionGroupDigest)) continue;
      nextByGroup.set(fact.sessionGroupDigest, fact.nodeKey);
    }
    let selected: { fact: T; identity: ReplayIdentity } | undefined;
    for (const fact of orderedFacts) {
      if (applied.has(fact.nodeKey)
        || (fact.sessionGroupDigest !== undefined && !eligibleGroups.has(fact.sessionGroupDigest))) continue;
      if (fact.sessionGroupDigest !== undefined
        && nextByGroup.get(fact.sessionGroupDigest) !== fact.nodeKey) continue;
      const instance = projection.instances[fact.nodeKey];
      if (instance?.status !== "ready") continue;
      const node = nodes.get(instance.nodeId);
      if (!node || (node.kind !== "agent" && node.kind !== "task" && node.kind !== "signal")) continue;
      const identity = replayEvaluation(
        node,
        completedScopeForFrame(projection, instance.parentFrameKey ?? "root", baseScope),
        node.kind === "agent" ? child.frozen.ir.agents[node.run.agent] : undefined,
        child.artifactDigest,
      ).replayIdentity;
      if (identity && sameIdentity(fact, identity)) {
        selected = { fact, identity };
        break;
      }
    }
    if (!selected) break;
    const { fact, identity } = selected;
    const events: SchedulerEvent[] = [{
      type: "instance.completed" as const,
      payload: {
        nodeKey: fact.nodeKey,
        ...(fact.output === undefined ? {} : { output: fact.output }),
        replayIdentity: identity,
      },
    }];
    const member = projection.groupMembers[fact.nodeKey];
    if (member?.status === "ready" || member?.status === "running") {
      events.push({
        type: "group.member_completed" as const,
        payload: {
          memberKey: member.memberKey,
          completionSequence: applied.size + 1,
          ...(fact.output === undefined ? {} : { output: fact.output }),
        },
      });
    }
    applied.add(fact.nodeKey);
    if (identity.sessionGroupDigest) {
      const order = sessionOrder.get(identity.sessionGroupDigest) ?? [];
      order.push(fact.nodeKey);
      sessionOrder.set(identity.sessionGroupDigest, order);
    }
    projection = settleFrozenProjection({
      frozen: child.frozen,
      projection: applySchedulerEvents(projection, events),
      now: new Date(0),
    }).projection;
  }
  return { projection, sessionOrder };
}

function terminalFrame(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function lastDynamicIndex(path: InstancePath): number {
  const segment = path[path.length - 1];
  return segment?.kind === "fanout" ? segment.itemIndex : segment?.kind === "loop" ? segment.iter : -1;
}

function sameIdentity(left: ForkReplayPlanFact, right: ReplayIdentity): boolean {
  return left.operationDigest === right.operationDigest
    && left.inputDigest === right.inputDigest
    && left.sessionGroupDigest === right.sessionGroupDigest;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}
