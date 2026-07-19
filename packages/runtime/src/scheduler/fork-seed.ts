import { walkNodes, type NodeChildScope, type NodeIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { stableJson } from "../stable-json.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "./identity.js";
import { applySchedulerEvents, createSchedulerProjection, groupCompletionEvents } from "./transitions.js";
import type { SchedulerEvent } from "./events.js";
import type { InstancePath, InstancePathSegment, SchedulerProjection } from "./types.js";

export type ForkSeedFailure =
  | { type: "target-resolution-failure"; target: string; message: string }
  | { type: "dynamic-target-ambiguity"; target: string; message: string }
  | { type: "artifact-rewrite-failure"; artifactId: string; message: string };

export type ForkSeedPlan = {
  events: SchedulerEvent[];
  inheritedNodeKeys: Set<string>;
};

export type ForkSeedInput = {
  forkRunId: string;
  sourceWorkflow: WorkflowIR;
  replacementWorkflow: WorkflowIR;
  replacementScope: EvaluationScope;
  sourceProjection: SchedulerProjection;
  inputChanged: boolean;
  unsafeReuse?: boolean;
  target?: string;
};

type CompletedFact = {
  nodeKey: string;
  nodeId: string;
  signature: string;
  output?: JsonValue;
};

type SeedableCompletion = { nodeKey: string; event: Extract<SchedulerEvent, { type: "instance.completed" }> };

export function planTargetedForkSeed(input: ForkSeedInput): Result<ForkSeedPlan, ForkSeedFailure> {
  const sourceFacts = input.inputChanged && !input.unsafeReuse
    ? new Map<string, CompletedFact>()
    : completedFacts(input.sourceProjection, semanticNodeSignatures(input.sourceWorkflow));
  const replacementSignatures = semanticNodeSignatures(input.replacementWorkflow);
  const target = resolveForkTarget(input, sourceFacts, replacementSignatures);
  if (target.isErr()) return err(target.error);
  const events: SchedulerEvent[] = [];
  const inheritedNodeKeys = new Set<string>();
  let projection = createSchedulerProjection(input.forkRunId);

  const append = (nextEvents: SchedulerEvent[]): void => {
    if (nextEvents.length === 0) return;
    projection = applySchedulerEvents(projection, nextEvents);
    events.push(...nextEvents);
  };

  append(bootstrapRootEvents(input.forkRunId, input.replacementWorkflow, input.replacementScope));

  for (let guard = 0; guard < 10_000; guard += 1) {
    const step = nextSeedMaterializationStep({
      projection,
      sourceProjection: input.sourceProjection,
      sourceFacts,
      replacementSignatures,
      target: target.value,
      replacementWorkflow: input.replacementWorkflow,
      replacementScope: input.replacementScope,
      unsafeReuse: input.unsafeReuse === true,
    });
    if (!step) {
      if (target.value.kind === "dynamic" && !projection.instances[target.value.nodeKey] && (isTerminalRunStatus(projection.run.status) || !targetPathStillPossible(projection, target.value.path))) {
        return err({
          type: "target-resolution-failure",
          target: target.value.nodeKey,
          message: `Fork target '${target.value.nodeKey}' was not materialized in the replacement workflow.`,
        });
      }
      if (target.value.kind === "static" && !staticTargetMaterialized(projection, target.value) && (isTerminalRunStatus(projection.run.status) || !targetPathStillPossible(projection, target.value.path))) {
        return err({
          type: "target-resolution-failure",
          target: target.value.nodeId,
          message: `Fork target '${target.value.nodeId}' was not materialized in the replacement workflow.`,
        });
      }
      return ok({ events, inheritedNodeKeys });
    }
    append(step.events);
    for (const item of step.completions) inheritedNodeKeys.add(item.nodeKey);
  }

  throw new Error("Targeted fork seed planning did not converge.");
}

type ResolvedTarget =
  | { kind: "root" }
  | { kind: "static"; nodeId: string; node: NodeIR; path: InstancePath; prerequisitePatterns: PathPattern[] }
  | { kind: "dynamic"; nodeKey: string; path: InstancePath; prerequisitePatterns: PathPattern[] };

function resolveForkTarget(input: ForkSeedInput, sourceFacts: Map<string, CompletedFact>, replacementSignatures: Map<string, string>): Result<ResolvedTarget, ForkSeedFailure> {
  const { replacementWorkflow: workflow, sourceProjection, target } = input;
  if (target === undefined) return ok({ kind: "root" });
  if (target.includes("~")) {
    const targetPath = sourceProjection.instances[target]?.instancePath ?? replacementMaterializedPath(input, sourceFacts, replacementSignatures, target);
    if (!targetPath) return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' was not materialized in the replacement workflow.` });
    const replacementNode = nodeAtPath(workflow.root, targetPath);
    if (!replacementNode) {
      return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' does not resolve in the replacement workflow.` });
    }
    if (!isSchedulerLeaf(replacementNode)) {
      return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' is not a scheduler leaf target.` });
    }
    return ok({ kind: "dynamic", nodeKey: target, path: targetPath, prerequisitePatterns: prerequisiteLeafPatterns(workflow.root, targetPath) });
  }
  const paths = nodePaths(workflow.root).filter(path => path.node.id === target);
  if (paths.length === 0) {
    return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' was not found in the replacement workflow.` });
  }
  if (paths.length > 1) {
    return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' is ambiguous in the replacement workflow.` });
  }
  if (paths[0]!.ancestors.some(node => node.kind === "fanout" || node.kind === "loop")) {
    const targets = replacementMaterializedStaticTargets(input, sourceFacts, replacementSignatures, target);
    if (targets.length !== 1) {
      return err({ type: "dynamic-target-ambiguity", target, message: `Fork target '${target}' resolved to ${targets.length} dynamic replacement instances; use a dynamic nodeKey target.` });
    }
    const resolved = targets[0]!;
    return ok({ kind: "static", nodeId: target, node: resolved.node, path: resolved.path, prerequisitePatterns: prerequisiteLeafPatterns(workflow.root, resolved.path) });
  }
  return ok({ kind: "static", nodeId: target, node: paths[0]!.node, path: paths[0]!.path, prerequisitePatterns: prerequisiteLeafPatterns(workflow.root, paths[0]!.path) });
}

function replacementMaterializedPath(input: ForkSeedInput, sourceFacts: Map<string, CompletedFact>, replacementSignatures: Map<string, string>, target: string): InstancePath | undefined {
  let projection = createSchedulerProjection(input.forkRunId);
  projection = applySchedulerEvents(projection, bootstrapRootEvents(input.forkRunId, input.replacementWorkflow, input.replacementScope));
  for (let guard = 0; guard < 10_000; guard += 1) {
    const instance = projection.instances[target];
    if (instance) return instance.instancePath;
    const step = nextSeedMaterializationStep({
      projection,
      sourceProjection: input.sourceProjection,
      sourceFacts,
      replacementSignatures,
      target: { kind: "root" },
      replacementWorkflow: input.replacementWorkflow,
      replacementScope: input.replacementScope,
      unsafeReuse: input.unsafeReuse === true,
    });
    if (!step) return futureNodePath(input.replacementWorkflow, projection, target);
    projection = applySchedulerEvents(projection, step.events);
  }
  throw new Error("Replacement target materialization did not converge.");
}

function replacementMaterializedStaticTargets(input: ForkSeedInput, sourceFacts: Map<string, CompletedFact>, replacementSignatures: Map<string, string>, target: string): Array<{ node: NodeIR; path: InstancePath }> {
  let projection = createSchedulerProjection(input.forkRunId);
  projection = applySchedulerEvents(projection, bootstrapRootEvents(input.forkRunId, input.replacementWorkflow, input.replacementScope));
  for (let guard = 0; guard < 10_000; guard += 1) {
    const matches = staticTargetMatches(input.replacementWorkflow, projection, target);
    const step = nextSeedMaterializationStep({
      projection,
      sourceProjection: input.sourceProjection,
      sourceFacts,
      replacementSignatures,
      target: { kind: "root" },
      replacementWorkflow: input.replacementWorkflow,
      replacementScope: input.replacementScope,
      unsafeReuse: input.unsafeReuse === true,
    });
    if (!step) return matches;
    projection = applySchedulerEvents(projection, step.events);
  }
  throw new Error("Replacement static target materialization did not converge.");
}

function schedulerGroupCompletionEvents(projection: SchedulerProjection): SchedulerEvent[] {
  return Object.keys(projection.groups).flatMap(groupKey => groupCompletionEvents(projection, groupKey));
}

function nextSeedMaterializationStep(input: {
  projection: SchedulerProjection;
  sourceProjection: SchedulerProjection;
  sourceFacts: Map<string, CompletedFact>;
  replacementSignatures: Map<string, string>;
  target: ResolvedTarget;
  replacementWorkflow: WorkflowIR;
  replacementScope: EvaluationScope;
  unsafeReuse: boolean;
}): { events: SchedulerEvent[]; completions: SeedableCompletion[] } | undefined {
  const completions = seedableCompletionEvents(input);
  if (completions.length > 0) return { events: completions.map(item => item.event), completions };
  const groupEvents = schedulerGroupCompletionEvents(input.projection);
  if (groupEvents.length > 0) return { events: groupEvents, completions: [] };
  const next = continueRootEvents(input.replacementWorkflow, input.projection, input.replacementScope);
  return next.length === 0 ? undefined : { events: next, completions: [] };
}

function seedableCompletionEvents(input: {
  projection: SchedulerProjection;
  sourceProjection: SchedulerProjection;
  sourceFacts: Map<string, CompletedFact>;
  replacementSignatures: Map<string, string>;
  target: ResolvedTarget;
  unsafeReuse: boolean;
}): SeedableCompletion[] {
  return Object.values(input.projection.instances)
    .filter(instance => instance.status === "ready")
    .filter(instance => isEligibleForTarget(instance.instancePath, input.target))
    .filter(instance => acceptedControlPath(input.sourceProjection, instance.instancePath))
    .filter(instance => !isTarget(instance.nodeKey, instance.nodeId, input.target))
    .flatMap(instance => {
      const fact = input.sourceFacts.get(instance.nodeKey);
      if (!fact || fact.nodeId !== instance.nodeId) return [];
      const replacementSignature = compatibilitySignature(input.replacementSignatures, instance.instancePath);
      if (!input.unsafeReuse && (!replacementSignature || fact.signature !== replacementSignature)) return [];
      return [{
        nodeKey: instance.nodeKey,
        event: {
          type: "instance.completed",
          payload: {
            nodeKey: instance.nodeKey,
            ...(fact.output === undefined ? {} : { output: fact.output }),
          },
        } satisfies Extract<SchedulerEvent, { type: "instance.completed" }>,
      }];
    });
}

function isEligibleForTarget(candidatePath: InstancePath, target: ResolvedTarget): boolean {
  if (target.kind === "root") return true;
  return target.prerequisitePatterns.some(pattern => matchesPattern(pattern, candidatePath));
}

function acceptedControlPath(sourceProjection: SchedulerProjection, path: InstancePath): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    if (segment.kind !== "branch" && segment.kind !== "fanout") continue;
    const groupKey = deriveInstanceKey(appendNode(path.slice(0, index), segment.nodeId));
    const group = sourceProjection.groups[groupKey];
    if (!group) continue;
    if (group.kind === "parallel" && group.strategy !== "race") continue;
    if (group.kind === "fanout" && group.strategy !== "quorum") continue;
    if (group.status !== "completed") return false;

    const acceptedMemberKeys = acceptedMemberKeysFromResult(group.result);
    const memberKey = deriveInstanceKey(path.slice(0, index + 1));
    if (!acceptedMemberKeys.includes(memberKey)) return false;
    if (group.kind === "fanout" && group.strategy === "quorum" && acceptedMemberKeys.join("\0") !== [...acceptedMemberKeys].sort().join("\0")) return false;
  }
  return true;
}

function acceptedMemberKeysFromResult(result: JsonValue | undefined): string[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const value = result.acceptedMemberKeys;
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

function isTarget(nodeKey: string, nodeId: string, target: ResolvedTarget): boolean {
  if (target.kind === "root") return false;
  if (target.kind === "dynamic") return nodeKey === target.nodeKey;
  return nodeId === target.nodeId;
}

function staticTargetMaterialized(projection: SchedulerProjection, target: Extract<ResolvedTarget, { kind: "static" }>): boolean {
  if (isSchedulerLeaf(target.node)) {
    return Object.values(projection.instances).some(instance => instance.nodeId === target.nodeId && pathKey(instance.instancePath) === pathKey(target.path));
  }
  const frame = projection.frames[deriveInstanceKey(target.path)];
  return frame !== undefined && frame.nodeId === target.nodeId;
}

function targetPathStillPossible(projection: SchedulerProjection, path: InstancePath): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    if (segment.kind === "node") return true;

    const prefix = path.slice(0, index + 1);
    const frameKey = deriveInstanceKey(prefix);
    if (projection.frames[frameKey]) continue;

    const ownerKey = deriveInstanceKey(appendNode(path.slice(0, index), segment.nodeId));
    if (segment.kind === "branch") {
      const decided = projection.branchDecisions[ownerKey];
      if (decided && decided !== segment.branchId) return false;
      const group = projection.groups[ownerKey];
      if (group?.kind === "parallel" && !projection.groupMembers[frameKey]) return false;
      continue;
    }

    if (segment.kind === "fanout") {
      const group = projection.groups[ownerKey];
      if (group?.kind === "fanout" && !projection.groupMembers[frameKey]) return false;
      continue;
    }

    const loop = projection.frames[ownerKey];
    if (loop && (loop.status === "completed" || loop.status === "failed" || loop.status === "cancelled")) return false;
    if (loop?.loop && loop.loop.iter > segment.iter) return false;
  }
  return true;
}

function futureNodePath(workflow: WorkflowIR, projection: SchedulerProjection, target: string): InstancePath | undefined {
  for (const { path } of futureDirectNodeMatches(workflow, projection, candidate => isSchedulerLeaf(candidate.node) && deriveInstanceKey(candidate.path) === target)) return path;
  return undefined;
}

function staticTargetMatches(workflow: WorkflowIR, projection: SchedulerProjection, target: string): Array<{ node: NodeIR; path: InstancePath }> {
  const byKey = new Map<string, { node: NodeIR; path: InstancePath }>();
  for (const instance of Object.values(projection.instances)) {
    if (instance.nodeId !== target) continue;
    const node = nodeAtPath(workflow.root, instance.instancePath);
    if (node) byKey.set(pathKey(instance.instancePath), { node, path: instance.instancePath });
  }
  for (const frame of Object.values(projection.frames)) {
    if (!frame.instancePath || frame.nodeId !== target) continue;
    const node = nodeAtPath(workflow.root, frame.instancePath);
    if (node) byKey.set(pathKey(frame.instancePath), { node, path: frame.instancePath });
  }
  for (const match of futureDirectNodeMatches(workflow, projection, candidate => candidate.node.id === target, { includeLoopIterations: false })) {
    byKey.set(pathKey(match.path), match);
  }
  return [...byKey.values()];
}

function futureDirectNodeMatches(
  workflow: WorkflowIR,
  projection: SchedulerProjection,
  predicate: (candidate: { node: NodeIR; path: InstancePath }) => boolean,
  options: { includeLoopIterations?: boolean } = {},
): Array<{ node: NodeIR; path: InstancePath }> {
  const out: Array<{ node: NodeIR; path: InstancePath }> = [];
  const frames = Object.values(projection.frames).filter(frame =>
    frame.status === "running"
      && (frame.frameKind === "root" || frame.frameKind === "branch" || frame.frameKind === "fanout_item" || (options.includeLoopIterations !== false && frame.frameKind === "loop_iteration"))
  );
  for (const frame of frames) {
    const basePath = frame.frameKey === "root" ? [] : frame.instancePath;
    if (!basePath) continue;
    const scope = scopeAtPath(workflow.root, basePath);
    if (!scope) continue;
    for (const node of scope.nodes) {
      const path = appendNode(basePath, node.id);
      const candidate = { node, path };
      if (predicate(candidate)) out.push(candidate);
    }
  }
  return out;
}

function isSchedulerLeaf(node: NodeIR): boolean {
  return node.kind === "agent" || node.kind === "task" || node.kind === "signal";
}

function completedFacts(projection: SchedulerProjection, signatures: Map<string, string>): Map<string, CompletedFact> {
  return new Map(Object.values(projection.instances)
    .filter(instance => instance.status === "completed")
    .flatMap(instance => {
      const signature = compatibilitySignature(signatures, instance.instancePath);
      if (!signature) return [];
      return [[instance.nodeKey, {
        nodeKey: instance.nodeKey,
        nodeId: instance.nodeId,
        signature,
        ...(instance.output === undefined ? {} : { output: instance.output }),
      } satisfies CompletedFact]];
    }));
}

function semanticNodeSignatures(workflow: WorkflowIR): Map<string, string> {
  return new Map(Array.from(walkNodes(workflow.root), ({ node, ancestry }) => [
    pathKey(appendNode(representativeInstancePath(ancestry), node.id)),
    stableJsonLine(semanticNodeSignature(node, workflow)),
  ] as const));
}

function semanticNodeSignature(node: NodeIR, workflow: WorkflowIR): unknown {
  const semantic = node;
  if (semantic.kind === "agent") return { ...semantic, agentDefinition: workflow.agents[semantic.run.agent] };
  if (semantic.kind === "if") return { id: semantic.id, kind: semantic.kind, condition: semantic.condition, branches: ["then", "else"] };
  if (semantic.kind === "switch") return { id: semantic.id, kind: semantic.kind, cases: semantic.cases.map(c => c.when), default: true };
  if (semantic.kind === "parallel") return { id: semantic.id, kind: semantic.kind, strategy: semantic.strategy, maxConcurrency: semantic.maxConcurrency, branchIds: Object.keys(semantic.branches) };
  if (semantic.kind === "fanout") return { id: semantic.id, kind: semantic.kind, over: semantic.over, strategy: semantic.strategy, count: semantic.count, maxConcurrency: semantic.maxConcurrency };
  if (semantic.kind === "loop") return { id: semantic.id, kind: semantic.kind, state: semantic.state, output: semantic.do.output };
  return semantic;
}

function compatibilitySignature(signatures: Map<string, string>, path: InstancePath): string | undefined {
  const parts: string[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    parts.push(stableJsonLine(segment));
    if (segment.kind === "node") {
      const signature = signatures.get(signaturePathKey(path.slice(0, index + 1)));
      if (!signature) return undefined;
      parts.push(signature);
    } else {
      const signature = signatures.get(signaturePathKey(appendNode(path.slice(0, index), segment.nodeId)));
      if (!signature) return undefined;
      parts.push(signature);
    }
  }
  return stableJsonLine(parts);
}

function nodePaths(scope: ScopeIR): Array<{ node: NodeIR; ancestors: NodeIR[]; path: InstancePath }> {
  return Array.from(walkNodes(scope), ({ node, ancestry }) => ({
    node,
    ancestors: ancestry.map(({ owner }) => owner),
    path: appendNode(representativeInstancePath(ancestry), node.id),
  }));
}

function representativeInstancePath(ancestry: readonly NodeChildScope[]): InstancePath {
  let path: InstancePath = [];
  for (const child of ancestry) {
    if (child.kind === "fanout") path = appendFanoutItem(path, child.owner.id, 0);
    else if (child.kind === "loop") path = appendLoopIteration(path, child.owner.id, 0);
    else path = appendBranch(path, child.owner.id, child.branchId);
  }
  return path;
}

function pathKey(path: readonly InstancePathSegment[]): string {
  return stableJsonLine(path);
}

type PathPatternSegment =
  | { kind: "node"; nodeId: string }
  | { kind: "branch"; nodeId: string; branchId: string }
  | { kind: "fanout"; nodeId: string; itemIndex?: number }
  | { kind: "loop"; nodeId: string; iter?: number };

type PathPattern = readonly PathPatternSegment[];

function prerequisiteLeafPatterns(scope: ScopeIR, targetPath: InstancePath, basePath: PathPattern = []): PathPattern[] {
  const out: PathPattern[] = [];
  const next = targetPath[basePath.length];
  if (!next) return out;
  if (next.kind !== "node") {
    const ownerIndex = scope.nodes.findIndex(node => node.id === next.nodeId);
    if (ownerIndex < 0) return out;
    for (const node of scope.nodes.slice(0, ownerIndex)) {
      out.push(...leafPatterns(node, basePath));
    }
    const owner = scope.nodes[ownerIndex]!;
    if (next.kind === "branch") {
      const childScope = branchScope(owner, next.branchId);
      if (childScope) out.push(...prerequisiteLeafPatterns(childScope, targetPath, targetPath.slice(0, basePath.length + 1)));
    }
    if (next.kind === "fanout" || next.kind === "loop") {
      const childScope = owner.kind === next.kind ? owner.do : undefined;
      if (next.kind === "loop" && owner.kind === "loop") {
        for (let iter = 0; iter < next.iter; iter += 1) {
          out.push(...leafPatternsInScope(owner.do, [...basePath, { kind: "loop", nodeId: next.nodeId, iter }]));
        }
      }
      if (childScope) out.push(...prerequisiteLeafPatterns(childScope, targetPath, targetPath.slice(0, basePath.length + 1)));
    }
    return out;
  }
  const targetIndex = scope.nodes.findIndex(node => node.id === next.nodeId);
  if (targetIndex < 0) return out;
  for (const node of scope.nodes.slice(0, targetIndex)) {
    out.push(...leafPatterns(node, basePath));
  }
  const targetNode = scope.nodes[targetIndex]!;
  const branch = targetPath[basePath.length + 1];
  if (!branch) return out;
  const childBase = targetPath.slice(0, basePath.length + 2);
  if (branch.kind === "branch") {
    const childScope = branchScope(targetNode, branch.branchId);
    if (childScope) out.push(...prerequisiteLeafPatterns(childScope, targetPath, childBase));
  }
  return out;
}

function leafPatterns(node: NodeIR, basePath: PathPattern): PathPattern[] {
  const nodePath = appendPatternNode(basePath, node.id);
  if (isSchedulerLeaf(node)) return [nodePath];
  if (node.kind === "if") return [...leafPatternsInScope(node.then, appendPatternBranch(basePath, node.id, "then")), ...leafPatternsInScope(node.else, appendPatternBranch(basePath, node.id, "else"))];
  if (node.kind === "switch") return [
    ...node.cases.flatMap((c, index) => leafPatternsInScope(c.then, appendPatternBranch(basePath, node.id, `case:${index}`))),
    ...leafPatternsInScope(node.default, appendPatternBranch(basePath, node.id, "default")),
  ];
  if (node.kind === "parallel" && node.strategy === "all") return Object.entries(node.branches).flatMap(([branchId, branch]) => leafPatternsInScope(branch, appendPatternBranch(basePath, node.id, branchId)));
  if (node.kind === "fanout" && node.strategy === "all") return leafPatternsInScope(node.do, [...basePath, { kind: "fanout", nodeId: node.id }]);
  if (node.kind === "loop") return leafPatternsInScope(node.do, [...basePath, { kind: "loop", nodeId: node.id }]);
  return [];
}

function leafPatternsInScope(scope: ScopeIR, basePath: PathPattern): PathPattern[] {
  return scope.nodes.flatMap(node => leafPatterns(node, basePath));
}

function matchesPattern(pattern: PathPattern, path: InstancePath): boolean {
  return pattern.length === path.length && pattern.every((expected, index) => {
    const actual = path[index]!;
    if (expected.kind !== actual.kind || expected.nodeId !== actual.nodeId) return false;
    if (expected.kind === "branch") return actual.kind === "branch" && expected.branchId === actual.branchId;
    if (expected.kind === "fanout") {
      return actual.kind === "fanout"
        && (expected.itemIndex === undefined || expected.itemIndex === actual.itemIndex);
    }
    if (expected.kind === "loop") return actual.kind === "loop" && (expected.iter === undefined || expected.iter === actual.iter);
    return true;
  });
}

function nodeAtPath(scope: ScopeIR, path: InstancePath): NodeIR | undefined {
  let current: ScopeIR | undefined = scope;
  for (let index = 0; index < path.length; index += 1) {
    if (!current) return undefined;
    const segment = path[index]!;
    if (segment.kind === "node") {
      const node = current.nodes.find(candidate => candidate.id === segment.nodeId);
      return index === path.length - 1 ? node : undefined;
    }
    const owner = current.nodes.find(candidate => candidate.id === segment.nodeId);
    if (!owner) return undefined;
    if (segment.kind === "branch") current = branchScope(owner, segment.branchId);
    else if (segment.kind === "fanout") current = owner.kind === "fanout" ? owner.do : undefined;
    else current = owner.kind === "loop" ? owner.do : undefined;
  }
  return undefined;
}

function scopeAtPath(scope: ScopeIR, path: InstancePath): ScopeIR | undefined {
  let current: ScopeIR | undefined = scope;
  for (const segment of path) {
    if (!current) return undefined;
    if (segment.kind === "node") continue;
    const owner = current.nodes.find(candidate => candidate.id === segment.nodeId);
    if (!owner) return undefined;
    if (segment.kind === "branch") current = branchScope(owner, segment.branchId);
    else if (segment.kind === "fanout") current = owner.kind === "fanout" ? owner.do : undefined;
    else current = owner.kind === "loop" ? owner.do : undefined;
  }
  return current;
}

function appendPatternNode(path: PathPattern, nodeId: string): PathPattern {
  return [...path, { kind: "node", nodeId }];
}

function appendPatternBranch(path: PathPattern, nodeId: string, branchId: string): PathPattern {
  return [...path, { kind: "branch", nodeId, branchId }];
}

function branchScope(node: NodeIR, branchId: string): ScopeIR | undefined {
  if (node.kind === "if") return branchId === "then" ? node.then : branchId === "else" ? node.else : undefined;
  if (node.kind === "switch") {
    if (branchId === "default") return node.default;
    const index = Number(branchId.replace("case:", ""));
    return Number.isInteger(index) ? node.cases[index]?.then : undefined;
  }
  if (node.kind === "parallel") return node.branches[branchId];
  return undefined;
}

function isTerminalRunStatus(status: SchedulerProjection["run"]["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function signaturePathKey(path: readonly InstancePathSegment[]): string {
  return pathKey(path.map(segment => {
    if (segment.kind === "fanout") return { kind: "fanout", nodeId: segment.nodeId, itemIndex: 0 };
    if (segment.kind === "loop") return { kind: "loop", nodeId: segment.nodeId, iter: 0 };
    return segment;
  }));
}

function stableJsonLine(value: unknown): string {
  return `${stableJson(value)}\n`;
}
