import { describe, expect, it } from "vitest";
import type { AgentDefinitionIR, NodeIR, WorkflowIR } from "@acpus/core/ir";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { bootstrapRootEvents, continueRootEvents } from "../src/scheduler/materialize.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { planTargetedForkSeed, type ForkSeedPlan } from "../src/scheduler/fork-seed.js";
import { applySchedulerEvents, createSchedulerProjection, groupCompletionEvents } from "../src/scheduler/transitions.js";

describe("targeted fork seed planning", () => {
  it("seeds compatible completed root prerequisites", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const source = sourceProjection(workflow([taskNode("first"), taskNode("second")]), [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { ok: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([taskNode("first"), taskNode("second")]),
      replacementWorkflow: workflow([taskNode("first"), taskNode("fixed")]),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([firstKey]));
    expect(plan.value.events).toContainEqual({ type: "instance.completed", payload: { nodeKey: firstKey, output: { ok: true } } });
    const seeded = seedProjection(plan.value);
    expect(seeded.instances[firstKey]).toMatchObject({ status: "completed", output: { ok: true } });
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });

  it("does not seed when fork input changed", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const source = sourceProjection(workflow([taskNode("first")]), [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { ok: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([taskNode("first")]),
      replacementWorkflow: workflow([taskNode("first")]),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: true,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
    expect(plan.value.events).not.toContainEqual(expect.objectContaining({ type: "instance.completed" }));
  });

  it("unsafe reuse seeds completed facts despite input and signature changes", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const sourceWorkflow = workflow([taskNode("first")]);
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { ok: true } } },
    ]);

    const changedSignature = planTargetedForkSeed({
      forkRunId: "fork-signature",
      sourceWorkflow,
      replacementWorkflow: workflow([taskNode("first", "async function changed() { return {}; }")]),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });
    expect(changedSignature.isOk()).toBe(true);
    if (changedSignature.isErr()) throw new Error(changedSignature.error.message);
    expect(changedSignature.value.inheritedNodeKeys).toEqual(new Set());

    const unsafeChangedSignature = planTargetedForkSeed({
      forkRunId: "fork-unsafe-signature",
      sourceWorkflow,
      replacementWorkflow: workflow([taskNode("first", "async function changed() { return {}; }")]),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
      unsafeReuse: true,
    });
    expect(unsafeChangedSignature.isOk()).toBe(true);
    if (unsafeChangedSignature.isErr()) throw new Error(unsafeChangedSignature.error.message);
    expect(unsafeChangedSignature.value.inheritedNodeKeys).toEqual(new Set([firstKey]));

    const unsafeChangedInput = planTargetedForkSeed({
      forkRunId: "fork-unsafe-input",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: true,
      unsafeReuse: true,
    });
    expect(unsafeChangedInput.isOk()).toBe(true);
    if (unsafeChangedInput.isErr()) throw new Error(unsafeChangedInput.error.message);
    expect(unsafeChangedInput.value.inheritedNodeKeys).toEqual(new Set([firstKey]));
  });

  it("unsafe reuse does not seed an explicit target itself", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const secondKey = deriveInstanceKey(appendNode([], "second"));
    const sourceWorkflow = workflow([taskNode("first"), taskNode("second")]);
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { first: true } } },
    ]);
    source = continueUntilIdle(sourceWorkflow, source);
    source = applySchedulerEvents(source, [
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { second: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: workflow([taskNode("first", "async function changed() { return {}; }"), taskNode("second", "async function changed() { return {}; }")]),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: true,
      unsafeReuse: true,
      target: "second",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([firstKey]));
    const seeded = seedProjection(plan.value);
    expect(seeded.instances[firstKey]).toMatchObject({ status: "completed" });
    expect(seeded.instances[secondKey]).toMatchObject({ status: "ready" });
  });

  it("does not seed source facts that are not scheduler-accepted completions", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const sourceWorkflow = workflow([taskNode("first")]);
    const cases = [
      { name: "ready", events: [] },
      { name: "awaiting", events: [{ type: "instance.awaiting", payload: { nodeKey: firstKey, statusReason: "signal" } }] },
      { name: "failed", events: [{ type: "instance.failed", payload: { nodeKey: firstKey, error: { reason: "boom" } } }] },
      { name: "cancelled", events: [{ type: "instance.cancelled", payload: { nodeKey: firstKey, cancelReason: "operator_cancelled" } }] },
      { name: "requeued", events: [
        { type: "instance.started", payload: { nodeKey: firstKey } },
        { type: "instance.requeued", payload: { nodeKey: firstKey, reason: "superseded" } },
      ] },
    ] satisfies Array<{ name: string; events: Parameters<typeof applySchedulerEvents>[1] }>;

    for (const item of cases) {
      let source = continueUntilIdle(sourceWorkflow, sourceProjection(sourceWorkflow, []));
      source = applySchedulerEvents(source, item.events);

      const plan = planTargetedForkSeed({
        forkRunId: `fork-${item.name}`,
        sourceWorkflow,
        replacementWorkflow: sourceWorkflow,
        replacementScope: rootScope(),
        sourceProjection: source,
        inputChanged: false,
      });

      expect(plan.isOk()).toBe(true);
      if (plan.isErr()) throw new Error(plan.error.message);
      expect(plan.value.inheritedNodeKeys, item.name).toEqual(new Set());
      expect(plan.value.events, item.name).not.toContainEqual({ type: "instance.completed", payload: { nodeKey: firstKey } });

      const unsafePlan = planTargetedForkSeed({
        forkRunId: `fork-unsafe-${item.name}`,
        sourceWorkflow,
        replacementWorkflow: sourceWorkflow,
        replacementScope: rootScope(),
        sourceProjection: source,
        inputChanged: true,
        unsafeReuse: true,
      });

      expect(unsafePlan.isOk()).toBe(true);
      if (unsafePlan.isErr()) throw new Error(unsafePlan.error.message);
      expect(unsafePlan.value.inheritedNodeKeys, item.name).toEqual(new Set());
      expect(unsafePlan.value.events, item.name).not.toContainEqual({ type: "instance.completed", payload: { nodeKey: firstKey } });
    }
  });

  it("fails dynamic targets that never materialize", () => {
    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([taskNode("first")]),
      replacementWorkflow: workflow([taskNode("first")]),
      replacementScope: rootScope(),
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target: "missing~abc",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected missing dynamic target");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target: "missing~abc" });
  });

  it("resolves a source occurrence ref and rejects attempt selectors", () => {
    const path = appendNode([], "first");
    const target = deriveInstanceKey(path);
    const ref = deriveOccurrenceRef(path);
    const sourceWorkflow = workflow([taskNode("first")]);
    const source = sourceProjection(sourceWorkflow, []);
    const input = {
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    };

    const plan = planTargetedForkSeed({ ...input, target: ref });
    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(seedProjection(plan.value).instances[target]).toBeDefined();

    const attempt = planTargetedForkSeed({ ...input, target: `${ref}#1` });
    expect(attempt.isErr()).toBe(true);
    if (attempt.isOk()) throw new Error("expected attempt selector rejection");
    expect(attempt.error).toMatchObject({
      type: "target-resolution-failure",
      target: `${ref}#1`,
    });
    expect(attempt.error.message).toContain("without an attempt suffix");
  });

  it("resolves dynamic targets that materialize only in the replacement workflow", () => {
    const itemPath = appendFanoutItem([], "items", 0);
    const target = deriveInstanceKey(appendNode(itemPath, "target"));
    const replacementWorkflow = workflow([fanoutNode([taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a"] } };

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([]),
      replacementWorkflow,
      replacementScope: scope,
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("resolves replacement-only dynamic targets after seedable prerequisites", () => {
    const itemPath = appendFanoutItem([], "items", 1);
    const prepare = deriveInstanceKey(appendNode(itemPath, "prepare"));
    const target = deriveInstanceKey(appendNode(itemPath, "target"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare")])]);
    const replacementWorkflow = workflow([fanoutNode([taskNode("prepare"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { item: "b" } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([prepare]));
  });

  it("admits replacement-only dynamic targets behind incompatible prerequisites", () => {
    const itemPath = appendFanoutItem([], "items", 1);
    const prepare = deriveInstanceKey(appendNode(itemPath, "prepare"));
    const target = deriveInstanceKey(appendNode(itemPath, "target"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare")])]);
    const replacementWorkflow = workflow([fanoutNode([taskNode("prepare", "async function changed() { return {}; }"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { item: "b" } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("rejects replacement-only dynamic targets behind undecided control paths", () => {
    const itemPath = appendFanoutItem([], "items", 0);
    const target = deriveInstanceKey(appendNode(appendBranch(itemPath, "choose", "then"), "inner"));
    const replacementWorkflow = workflow([fanoutNode([taskNode("prepare"), ifNode({ kind: "literal", value: false })])]);
    const scope = { ...rootScope(), input: { items: ["a"] } };

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([]),
      replacementWorkflow,
      replacementScope: scope,
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target,
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected undecided control path rejection");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target });
  });



  it("rejects source dynamic targets that cannot materialize in the replacement workflow", () => {
    const sourceItemPath = appendFanoutItem([], "items", 1);
    const prepare = deriveInstanceKey(appendNode(sourceItemPath, "prepare"));
    const target = deriveInstanceKey(appendNode(sourceItemPath, "target"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare"), taskNode("target")])]);
    const replacementWorkflow = sourceWorkflow;
    const sourceScope = { ...rootScope(), input: { items: ["a", "b"] } };
    const replacementScope = { ...rootScope(), input: { items: ["a"] } };
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { item: "b" } } },
    ], sourceScope);
    source = continueUntilIdle(sourceWorkflow, source, sourceScope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow,
      replacementScope,
      sourceProjection: source,
      inputChanged: false,
      target,
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected stale dynamic target failure");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target });
  });

  it("seeds prerequisites before a static composite target without seeding inside it", () => {
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const innerKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "left"), "left_first"));
    const sourceWorkflow = workflow([taskNode("first"), parallelNode()]);
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { first: true } } },
    ]);
    source = continueUntilIdle(sourceWorkflow, source);
    source = applySchedulerEvents(source, [
      { type: "instance.completed", payload: { nodeKey: innerKey, output: { inner: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
      target: "parallel",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([firstKey]));
  });

  it("seeds branch-local prerequisites but not unrelated siblings for an explicit target", () => {
    const leftFirstKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "left"), "left_first"));
    const rightKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "right"), "right_task"));
    const sourceWorkflow = workflow([parallelNode()]);
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: leftFirstKey, output: { left: true } } },
      { type: "instance.completed", payload: { nodeKey: rightKey, output: { right: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
      target: "left_target",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([leftFirstKey]));
    const seeded = seedProjection(plan.value);
    expect(seeded.groups[deriveInstanceKey(appendNode([], "parallel"))]).toMatchObject({ kind: "parallel", strategy: "all" });
    expect(seeded.groupMembers[deriveInstanceKey(appendBranch([], "parallel", "left"))]).toBeDefined();
    expect(seeded.groupMembers[deriveInstanceKey(appendBranch([], "parallel", "right"))]).toBeDefined();
    expect(seeded.instances[leftFirstKey]).toMatchObject({ status: "completed" });
    expect(seeded.instances[deriveInstanceKey(appendNode(appendBranch([], "parallel", "left"), "left_target"))]).toMatchObject({ status: "ready" });
    expect(seeded.instances[rightKey]).toMatchObject({ status: "ready" });
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });

  it("does not reuse inner leaves when ancestor control semantics change", () => {
    const innerKey = deriveInstanceKey(appendNode(appendBranch([], "choose", "then"), "inner"));
    const sourceWorkflow = workflow([ifNode({ kind: "literal", value: true })]);
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: innerKey, output: { ok: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: workflow([ifNode({ kind: "ref", path: ["input", "flag"] })]),
      replacementScope: { ...rootScope(), input: { flag: true } },
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("includes runtime configuration expressions in semantic signatures", () => {
    const nodeKey = deriveInstanceKey(appendNode([], "first"));
    const sourceWorkflow = workflow([{ ...taskNode("first"), timeout: { kind: "literal", value: "5s" } }]);
    const source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey, output: { ok: true } } },
    ]);
    const replacementWorkflow = workflow([{ ...taskNode("first"), timeout: { kind: "ref", path: ["input", "timeout"] } }]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow,
      replacementScope: { ...rootScope(), input: { timeout: "5s" } },
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("fails static targets on an unselected conditional path", () => {
    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([ifNode({ kind: "literal", value: true })]),
      replacementWorkflow: workflow([ifNode({ kind: "literal", value: false })]),
      replacementScope: rootScope(),
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target: "inner",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected unselected target failure");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target: "inner" });
  });

  it("fails static targets on an unselected conditional path even when another branch is ready", () => {
    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: workflow([ifNode({ kind: "literal", value: false }, { output: { kind: "object", fields: {} }, nodes: [taskNode("other")] })]),
      replacementWorkflow: workflow([ifNode({ kind: "literal", value: false }, { output: { kind: "object", fields: {} }, nodes: [taskNode("other")] })]),
      replacementScope: rootScope(),
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target: "inner",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected unselected target failure");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target: "inner" });
  });

  it("seeds only same-item prerequisites for a dynamic fanout target", () => {
    const fanoutPathA = appendFanoutItem([], "items", 0);
    const fanoutPathB = appendFanoutItem([], "items", 1);
    const firstA = deriveInstanceKey(appendNode(fanoutPathA, "prepare"));
    const firstB = deriveInstanceKey(appendNode(fanoutPathB, "prepare"));
    const targetB = deriveInstanceKey(appendNode(fanoutPathB, "target"));
    const fanoutWorkflow = workflow([fanoutNode([taskNode("prepare"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    let source = sourceProjection(fanoutWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstA, output: { item: "a" } } },
      { type: "instance.completed", payload: { nodeKey: firstB, output: { item: "b" } } },
    ], scope);
    source = continueUntilIdle(fanoutWorkflow, source, scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: targetB,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([firstB]));
    const seeded = seedProjection(plan.value);
    expect(seeded.groups[deriveInstanceKey(appendNode([], "items"))]).toMatchObject({ kind: "fanout", strategy: "all" });
    expect(seeded.groupMembers[deriveInstanceKey(fanoutPathA)]).toBeDefined();
    expect(seeded.groupMembers[deriveInstanceKey(fanoutPathB)]).toBeDefined();
    expect(seeded.instances[firstA]).toMatchObject({ status: "ready" });
    expect(seeded.instances[firstB]).toMatchObject({ status: "completed" });
    expect(seeded.instances[targetB]).toMatchObject({ status: "ready" });
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });

  it("resolves a static fanout target when replacement materializes one instance", () => {
    const fanoutPath = appendFanoutItem([], "items", 0);
    const prepare = deriveInstanceKey(appendNode(fanoutPath, "prepare"));
    const fanoutWorkflow = workflow([fanoutNode([taskNode("prepare"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a"] } };
    const source = sourceProjection(fanoutWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { item: "a" } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: "target",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([prepare]));
  });

  it("resolves a static fanout composite target when replacement materializes one frame", () => {
    const fanoutPath = appendFanoutItem([], "items", 0);
    const prepare = deriveInstanceKey(appendNode(fanoutPath, "prepare"));
    const inner = deriveInstanceKey(appendNode(appendBranch(fanoutPath, "choose", "then"), "inner"));
    const fanoutWorkflow = workflow([fanoutNode([taskNode("prepare"), ifNode({ kind: "literal", value: true })])]);
    const scope = { ...rootScope(), input: { items: ["a"] } };
    let source = sourceProjection(fanoutWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { item: "a" } } },
    ], scope);
    source = continueUntilIdle(fanoutWorkflow, source, scope);
    source = applySchedulerEvents(source, [
      { type: "instance.completed", payload: { nodeKey: inner, output: { inner: true } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: "choose",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([prepare]));
  });

  it("rejects static fanout targets that materialize multiple instances", () => {
    const fanoutWorkflow = workflow([fanoutNode([taskNode("target")])]);
    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: { ...rootScope(), input: { items: ["a", "b"] } },
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target: "target",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected ambiguous static fanout target");
    expect(plan.error).toMatchObject({ type: "dynamic-target-ambiguity", target: "target" });
  });

  it("resolves a static loop target when only one dynamic instance is materialized", () => {
    const iter0 = appendLoopIteration([], "retry", 0);
    const prepare = deriveInstanceKey(appendNode(iter0, "step"));
    const retryWorkflow = workflow([loopNode([taskNode("step"), taskNode("target")])]);
    const source = sourceProjection(retryWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { done: false } } },
    ]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: retryWorkflow,
      replacementWorkflow: retryWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
      target: "target",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([prepare]));
  });

  it("rejects static loop targets that are only future nodes in a running iteration", () => {
    const retryWorkflow = workflow([loopNode([taskNode("step"), taskNode("target")])]);
    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: retryWorkflow,
      replacementWorkflow: retryWorkflow,
      replacementScope: rootScope(),
      sourceProjection: sourceProjection(retryWorkflow, []),
      inputChanged: false,
      target: "target",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected static loop target to require a materialized dynamic instance");
    expect(plan.error).toMatchObject({ type: "dynamic-target-ambiguity", target: "target" });
  });

  it("resolves a static loop target independently of unrelated replacement input", () => {
    const iter0 = appendLoopIteration([], "retry", 0);
    const prepare = deriveInstanceKey(appendNode(iter0, "step"));
    const retryWorkflow = workflow([loopNode([taskNode("step"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { rounds: 1 } };
    const source = sourceProjection(retryWorkflow, [
      { type: "instance.completed", payload: { nodeKey: prepare, output: { done: false } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: retryWorkflow,
      replacementWorkflow: retryWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: "target",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([prepare]));
  });


  it("seeds fanout prerequisites before a later static target", () => {
    const fanoutPathA = appendFanoutItem([], "items", 0);
    const fanoutPathB = appendFanoutItem([], "items", 1);
    const firstA = deriveInstanceKey(appendNode(fanoutPathA, "prepare"));
    const firstB = deriveInstanceKey(appendNode(fanoutPathB, "prepare"));
    const fanoutWorkflow = workflow([fanoutNode([taskNode("prepare")]), taskNode("after")]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    const source = sourceProjection(fanoutWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstA, output: { item: "a" } } },
      { type: "instance.completed", payload: { nodeKey: firstB, output: { item: "b" } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: "after",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([firstA, firstB]));
  });

  it("does not seed quorum fanout members before a later static target", () => {
    const fanoutPathA = appendFanoutItem([], "items", 0);
    const fanoutPathB = appendFanoutItem([], "items", 1);
    const firstA = deriveInstanceKey(appendNode(fanoutPathA, "prepare"));
    const firstB = deriveInstanceKey(appendNode(fanoutPathB, "prepare"));
    const fanoutWorkflow = workflow([fanoutNode([taskNode("prepare")], { strategy: "quorum", count: 1 }), taskNode("after")]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    const source = sourceProjection(fanoutWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstA, output: { item: "a" } } },
      { type: "instance.completed", payload: { nodeKey: firstB, output: { item: "b" } } },
    ], scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: fanoutWorkflow,
      replacementWorkflow: fanoutWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: "after",
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("reuses agent nodes only when their effective agent definition is compatible", () => {
    const reviewKey = deriveInstanceKey(appendNode([], "review"));
    const reviewer = agentDefinition("codex");
    const sameReviewer = workflow([agentNode("review", "reviewer")], { reviewer, auditor: agentDefinition("old-auditor") });
    const source = sourceProjection(sameReviewer, [
      { type: "instance.completed", payload: { nodeKey: reviewKey, output: { ok: true } } },
    ]);

    const unchanged = planTargetedForkSeed({
      forkRunId: "fork-agent-unchanged",
      sourceWorkflow: sameReviewer,
      replacementWorkflow: sameReviewer,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });
    expect(unchanged.isOk()).toBe(true);
    if (unchanged.isErr()) throw new Error(unchanged.error.message);
    expect(unchanged.value.inheritedNodeKeys).toEqual(new Set([reviewKey]));

    const matchingChanged = planTargetedForkSeed({
      forkRunId: "fork-agent-changed",
      sourceWorkflow: sameReviewer,
      replacementWorkflow: workflow([agentNode("review", "reviewer")], { reviewer: agentDefinition("claude"), auditor: agentDefinition("old-auditor") }),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });
    expect(matchingChanged.isOk()).toBe(true);
    if (matchingChanged.isErr()) throw new Error(matchingChanged.error.message);
    expect(matchingChanged.value.inheritedNodeKeys).toEqual(new Set());

    const unrelatedChanged = planTargetedForkSeed({
      forkRunId: "fork-agent-unrelated",
      sourceWorkflow: sameReviewer,
      replacementWorkflow: workflow([agentNode("review", "reviewer")], { reviewer, auditor: agentDefinition("new-auditor") }),
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });
    expect(unrelatedChanged.isOk()).toBe(true);
    if (unrelatedChanged.isErr()) throw new Error(unrelatedChanged.error.message);
    expect(unrelatedChanged.value.inheritedNodeKeys).toEqual(new Set([reviewKey]));
  });

  it("seeds only the accepted race branch for root completion", () => {
    const winner = deriveInstanceKey(appendNode(appendBranch([], "race", "winner"), "winner_task"));
    const loser = deriveInstanceKey(appendNode(appendBranch([], "race", "loser"), "loser_task"));
    const sourceWorkflow = workflow([raceParallelNode()]);
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: winner, output: { value: "winner" } } },
    ]);
    source = continueUntilIdle(sourceWorkflow, source);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([winner]));
    expect(plan.value.inheritedNodeKeys.has(loser)).toBe(false);
    const seeded = seedProjection(plan.value);
    expect(seeded.groups[deriveInstanceKey(appendNode([], "race"))]).toMatchObject({ status: "completed", kind: "parallel", strategy: "race" });
    expect(seeded.instances[winner]).toMatchObject({ status: "completed" });
    expect(seeded.instances[loser]?.status).not.toBe("completed");
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });

  it("seeds accepted quorum fanout items without seeding unaccepted items", () => {
    const item0 = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 0), "prepare"));
    const item1 = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 1), "prepare"));
    const item2 = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 2), "prepare"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare")], { strategy: "quorum", count: 2 })]);
    const scope = { ...rootScope(), input: { items: ["a", "b", "c"] } };
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: item0, output: { item: "a" } } },
    ], scope);
    source = continueUntilIdle(sourceWorkflow, source, scope);
    source = applySchedulerEvents(source, [
      { type: "instance.completed", payload: { nodeKey: item1, output: { item: "b" } } },
    ]);
    source = continueUntilIdle(sourceWorkflow, source, scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([item0, item1]));
    expect(plan.value.inheritedNodeKeys.has(item2)).toBe(false);
    const seeded = seedProjection(plan.value);
    expect(seeded.groups[deriveInstanceKey(appendNode([], "items"))]).toMatchObject({ status: "completed", kind: "fanout", strategy: "quorum" });
    expect(seeded.instances[item0]).toMatchObject({ status: "completed" });
    expect(seeded.instances[item1]).toMatchObject({ status: "completed" });
    expect(seeded.instances[item2]?.status).not.toBe("completed");
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });

  it("does not seed quorum fanout items when accepted order is not stable", () => {
    const item0 = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 0), "prepare"));
    const item1 = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 1), "prepare"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare")], { strategy: "quorum", count: 2 })]);
    const scope = { ...rootScope(), input: { items: ["a", "b", "c"] } };
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: item1, output: { item: "b" } } },
    ], scope);
    source = continueUntilIdle(sourceWorkflow, source, scope);
    source = applySchedulerEvents(source, [
      { type: "instance.completed", payload: { nodeKey: item0, output: { item: "a" } } },
    ]);
    source = continueUntilIdle(sourceWorkflow, source, scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow: sourceWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("fails explicit targets when replacement materialization fails before the target", () => {
    const badWorkflow = workflow([{
      id: "items",
      kind: "fanout",
      strategy: "all",
      over: { kind: "literal", value: "not-array" },
      do: { nodes: [taskNode("prepare")], output: { kind: "object", fields: {} } },
    }, taskNode("after")]);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: badWorkflow,
      replacementWorkflow: badWorkflow,
      replacementScope: rootScope(),
      sourceProjection: createSchedulerProjection("source"),
      inputChanged: false,
      target: "after",
    });

    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) throw new Error("expected target resolution failure");
    expect(plan.error).toMatchObject({ type: "target-resolution-failure", target: "after" });
  });

  it("admits dynamic targets whose incompatible prerequisites must run in the fork", () => {
    const fanoutPathB = appendFanoutItem([], "items", 1);
    const firstB = deriveInstanceKey(appendNode(fanoutPathB, "prepare"));
    const targetB = deriveInstanceKey(appendNode(fanoutPathB, "target"));
    const sourceWorkflow = workflow([fanoutNode([taskNode("prepare"), taskNode("target")])]);
    const replacementWorkflow = workflow([fanoutNode([taskNode("prepare", "async function changed() { return {}; }"), taskNode("target")])]);
    const scope = { ...rootScope(), input: { items: ["a", "b"] } };
    let source = sourceProjection(sourceWorkflow, [
      { type: "instance.completed", payload: { nodeKey: firstB, output: { item: "b" } } },
    ], scope);
    source = continueUntilIdle(sourceWorkflow, source, scope);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow,
      replacementWorkflow,
      replacementScope: scope,
      sourceProjection: source,
      inputChanged: false,
      target: targetB,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set());
  });

  it("seeds prior loop iterations for a later dynamic loop target", () => {
    const iter0 = appendLoopIteration([], "retry", 0);
    const iter1 = appendLoopIteration([], "retry", 1);
    const step0 = deriveInstanceKey(appendNode(iter0, "step"));
    const target0 = deriveInstanceKey(appendNode(iter0, "target"));
    const step1 = deriveInstanceKey(appendNode(iter1, "step"));
    const target1 = deriveInstanceKey(appendNode(iter1, "target"));
    const retryWorkflow = workflow([loopNode([taskNode("step"), taskNode("target")])]);
    let source = sourceProjection(retryWorkflow, []);
    source = applySchedulerEvents(source, [{ type: "instance.completed", payload: { nodeKey: step0 } }]);
    source = continueUntilIdle(retryWorkflow, source);
    source = applySchedulerEvents(source, [{ type: "instance.completed", payload: { nodeKey: target0, output: { done: false } } }]);
    source = continueUntilIdle(retryWorkflow, source);
    source = applySchedulerEvents(source, [{ type: "instance.completed", payload: { nodeKey: step1 } }]);
    source = continueUntilIdle(retryWorkflow, source);

    const plan = planTargetedForkSeed({
      forkRunId: "fork",
      sourceWorkflow: retryWorkflow,
      replacementWorkflow: retryWorkflow,
      replacementScope: rootScope(),
      sourceProjection: source,
      inputChanged: false,
      target: target1,
    });

    expect(plan.isOk()).toBe(true);
    if (plan.isErr()) throw new Error(plan.error.message);
    expect(plan.value.inheritedNodeKeys).toEqual(new Set([step0, target0, step1]));
    const seeded = seedProjection(plan.value);
    expect(seeded.frames[deriveInstanceKey(appendNode([], "retry"))]).toMatchObject({ frameKind: "loop", status: "running" });
    expect(seeded.frames[deriveInstanceKey(iter0)]).toMatchObject({ frameKind: "loop_iteration", status: "completed" });
    expect(seeded.frames[deriveInstanceKey(iter1)]).toMatchObject({ frameKind: "loop_iteration", status: "running" });
    expect(seeded.instances[step0]).toMatchObject({ status: "completed" });
    expect(seeded.instances[target0]).toMatchObject({ status: "completed" });
    expect(seeded.instances[step1]).toMatchObject({ status: "completed" });
    expect(seeded.instances[target1]).toMatchObject({ status: "ready" });
    expect(Object.values(seeded.attempts)).toHaveLength(0);
  });
});

function seedProjection(plan: ForkSeedPlan) {
  return applySchedulerEvents(createSchedulerProjection("fork"), plan.events);
}

function sourceProjection(workflowIr: WorkflowIR, events: Parameters<typeof applySchedulerEvents>[1], scope = rootScope()) {
  return applySchedulerEvents(createSchedulerProjection("source"), [
    ...bootstrapRootEvents("source", workflowIr, scope),
    ...events,
  ]);
}

function continueUntilIdle(workflowIr: WorkflowIR, projection: ReturnType<typeof createSchedulerProjection>, scope = rootScope()) {
  let current = projection;
  for (let guard = 0; guard < 100; guard += 1) {
    const groupEvents = Object.keys(current.groups).flatMap(groupKey => groupCompletionEvents(current, groupKey));
    if (groupEvents.length > 0) {
      current = applySchedulerEvents(current, groupEvents);
      continue;
    }
    const events = continueRootEvents(workflowIr, current, scope);
    if (events.length === 0) return current;
    current = applySchedulerEvents(current, events);
  }
  throw new Error("scheduler materialization did not converge");
}

function rootScope() {
  return { input: {}, nodes: {}, meta: {}, fanout: {}, loop: {} };
}

function workflow(nodes: NodeIR[], agents: WorkflowIR["agents"] = {}): WorkflowIR {
  return {
    irVersion: 7,
    name: "fork-seed-test",
    agents,
    root: { output: { kind: "object", fields: {} }, nodes },

    diagnostics: [],
  };
}

function agentDefinition(use: string): AgentDefinitionIR {
  return { kind: "agent_definition", use };
}

function agentNode(id: string, agent: string): NodeIR {
  return {
    id,
    kind: "agent",
    run: {
      agent,
      prompt: { kind: "literal", value: "review" },
    },
  };
}

function taskNode(id: string, source = "async function task() { return {}; }"): Extract<NodeIR, { kind: "task" }> {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source },
    },
  };
}

function parallelNode(): NodeIR {
  return {
    id: "parallel",
    kind: "parallel",
    strategy: "all",
    branches: {
      left: { output: { kind: "object", fields: {} }, nodes: [taskNode("left_first"), taskNode("left_target")] },
      right: { output: { kind: "object", fields: {} }, nodes: [taskNode("right_task")] },
    },
  };
}

function raceParallelNode(): NodeIR {
  return {
    id: "race",
    kind: "parallel",
    strategy: "race",
    branches: {
      winner: { output: { kind: "object", fields: {} }, nodes: [taskNode("winner_task")] },
      loser: { output: { kind: "object", fields: {} }, nodes: [taskNode("loser_task")] },
    },
  };
}

function ifNode(condition: Extract<NodeIR, { kind: "if" }>["condition"], elseScope: Extract<NodeIR, { kind: "if" }>["else"] = { output: { kind: "object", fields: {} }, nodes: [] }): NodeIR {
  return {
    id: "choose",
    kind: "if",
    condition,
    then: { output: { kind: "object", fields: {} }, nodes: [taskNode("inner")] },
    else: elseScope,
  };
}

function fanoutNode(nodes: NodeIR[], options: { strategy?: "all" | "quorum"; count?: number } = {}): NodeIR {
  const base = {
    id: "items",
    kind: "fanout" as const,
    over: { kind: "ref" as const, path: ["input", "items"] },
    do: { nodes, output: { kind: "object" as const, fields: {} } },
  };
  if (options.strategy === "quorum") {
    return { ...base, strategy: "quorum", count: { kind: "literal", value: options.count ?? 1 } };
  }
  return { ...base, strategy: "all" };
}

function loopNode(nodes: NodeIR[]): NodeIR {
  return {
    id: "retry",
    kind: "loop",
    state: { kind: "object", fields: { done: { kind: "literal", value: false } } },
    do: {
      nodes,
      output: { kind: "object", fields: {
        state: { kind: "object", fields: { done: { kind: "ref", path: ["nodes", "target", "output", "done"] } } },
        stop: { kind: "ref", path: ["nodes", "target", "output", "done"] },
      } },
    },
  };
}
