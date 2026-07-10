import { describe, expect, it } from "vitest";
import type { NodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { bootstrapRootEvents, continueRootEvents } from "../src/scheduler/materialize.js";
import { applySchedulerEvents, createSchedulerProjection, groupCompletionEvents } from "../src/scheduler/transitions.js";

describe("scheduler materialization", () => {
  it("bootstraps the root frame and first root scheduler leaf conservatively", () => {
    const taskEvents = bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "task",
      kind: "task",
      run: { kind: "task_run", input: {}, target: inlineTaskTarget() },
    }));
    const nodeKey = deriveInstanceKey(appendNode([], "task"));

    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[0]).toEqual({ type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { task: nodeKey } } });
    expect(taskEvents[1]).toMatchObject({ type: "instance.ready", payload: { nodeId: "task", nodeKey, parentFrameKey: "root", readinessSequence: 1 } });
  });

  it("materializes root signal leaves as ready scheduler work", () => {
    const events = bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "approve",
      kind: "signal",
      run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
      timeout: "1m",
    }));

    expect(events.map(event => event.type)).toEqual(["frame.started", "instance.ready"]);
    expect(events[1]).toMatchObject({ type: "instance.ready", payload: { nodeId: "approve" } });
  });

  it("materializes failed root asserts as failed frames", () => {
    const workflow = workflowWithRootNode({
      id: "check",
      kind: "assert",
      condition: { kind: "literal", value: false },
    });
    const assertKey = deriveInstanceKey(appendNode([], "check"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    expect(projection.frames[assertKey]).toMatchObject({
      status: "failed",
      instancePath: appendNode([], "check"),
      error: { message: "Assert node 'check' failed." },
      terminalReason: "assert_failed",
    });
    expect(continueRootEvents(workflow, projection, {})).toEqual([
      { type: "frame.failed", payload: { frameKey: "root", error: { message: "Assert node 'check' failed." }, terminalReason: "assert_failed" } },
    ]);
  });

  it("materializes invalid control expressions as failed frames", () => {
    const checkKey = deriveInstanceKey(appendNode([], "check"));

    expect(bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "check",
      kind: "assert",
      condition: { kind: "literal", value: "not-boolean" },
    }))).toEqual([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { check: checkKey } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: checkKey, frameKind: "node" }) }),
      { type: "frame.failed", payload: { frameKey: checkKey, error: { reason: "expression_failed", message: "Assert node 'check' condition must evaluate to boolean." }, terminalReason: "expression_failed" } },
    ]);
  });

  it("materializes passing root asserts as completed frames", () => {
    const assertKey = deriveInstanceKey(appendNode([], "check"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "check",
      kind: "assert",
      condition: { kind: "literal", value: true },
    })));

    expect(projection.frames[assertKey]).toMatchObject({ status: "completed", instancePath: appendNode([], "check"), result: {}, terminalReason: "assert_passed" });
    expect(continueRootEvents(workflowWithRootNode({
      id: "check",
      kind: "assert",
      condition: { kind: "literal", value: true },
    }), projection, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: "root", result: {}, terminalReason: "root_completed" } },
    ]);
  });

  it("materializes root if decisions and selected branch leaves", () => {
    const ifNode: NodeIR = {
      id: "choose",
      kind: "if",
      condition: { kind: "literal", value: true },
      then: { nodes: [taskNode("then_task")], outputs: { value: { kind: "ref", path: ["nodes", "then_task", "output", "value"] } } },
      else: { nodes: [taskNode("else_task")], outputs: { value: { kind: "literal", value: "else" } } },
    };
    const workflow = workflowWithRootNode(ifNode);
    const ifKey = deriveInstanceKey(appendNode([], "choose"));
    const branchKey = deriveInstanceKey(appendBranch([], "choose", "then"));
    const thenKey = deriveInstanceKey(appendNode(appendBranch([], "choose", "then"), "then_task"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    expect(projection.branchDecisions[ifKey]).toBe("then");
    expect(projection.frames[ifKey]).toMatchObject({ status: "running", instancePath: appendNode([], "choose") });
    expect(projection.frames[branchKey]).toMatchObject({ status: "running", instancePath: appendBranch([], "choose", "then"), scope: { then_task: thenKey } });
    expect(projection.instances[thenKey]).toMatchObject({ status: "ready", readinessSequence: 1 });

    const afterLeaf = applySchedulerEvents(projection, [
      { type: "instance.completed", payload: { nodeKey: thenKey, output: { value: "then" } } },
    ]);
    expect(continueRootEvents(workflow, afterLeaf, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: branchKey, result: { value: "then" }, terminalReason: "branch_completed" } },
    ]);
  });

  it("propagates selected conditional leaf failures and cancellations", () => {
    const ifNode: NodeIR = {
      id: "choose",
      kind: "if",
      condition: { kind: "literal", value: true },
      then: { nodes: [taskNode("then_task")], outputs: {} },
      else: { nodes: [], outputs: {} },
    };
    const workflow = workflowWithRootNode(ifNode);
    const ifKey = deriveInstanceKey(appendNode([], "choose"));
    const branchKey = deriveInstanceKey(appendBranch([], "choose", "then"));
    const thenKey = deriveInstanceKey(appendNode(appendBranch([], "choose", "then"), "then_task"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    const failed = applySchedulerEvents(projection, [
      { type: "instance.failed", payload: { nodeKey: thenKey, error: { reason: "boom" }, statusReason: "node_failed" } },
    ]);
    const failBranch = continueRootEvents(workflow, failed, {});
    expect(failBranch).toEqual([
      { type: "frame.failed", payload: { frameKey: branchKey, error: { reason: "boom" }, terminalReason: "node_failed" } },
    ]);
    const failIf = continueRootEvents(workflow, applySchedulerEvents(failed, failBranch), {});
    expect(failIf).toEqual([
      { type: "frame.failed", payload: { frameKey: ifKey, error: { reason: "boom" }, terminalReason: "node_failed" } },
    ]);
    expect(continueRootEvents(workflow, applySchedulerEvents(failed, [...failBranch, ...failIf]), {})).toEqual([
      { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" }, terminalReason: "node_failed" } },
    ]);

    const cancelled = applySchedulerEvents(projection, [
      { type: "instance.cancelled", payload: { nodeKey: thenKey, cancelReason: "parent_failed" } },
    ]);
    const cancelBranch = continueRootEvents(workflow, cancelled, {});
    expect(cancelBranch).toEqual([
      { type: "frame.cancelled", payload: { frameKey: branchKey, cancelReason: "parent_failed" } },
    ]);
    const cancelIf = continueRootEvents(workflow, applySchedulerEvents(cancelled, cancelBranch), {});
    expect(cancelIf).toEqual([
      { type: "frame.cancelled", payload: { frameKey: ifKey, cancelReason: "parent_failed" } },
    ]);
    expect(continueRootEvents(workflow, applySchedulerEvents(cancelled, [...cancelBranch, ...cancelIf]), {})).toEqual([
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } },
    ]);
  });

  it("materializes root switch default empty branch output", () => {
    const switchNode: NodeIR = {
      id: "route",
      kind: "switch",
      cases: [{ when: { kind: "literal", value: false }, then: { nodes: [taskNode("case_task")], outputs: {} } }],
      default: { nodes: [], outputs: { value: { kind: "literal", value: "fallback" } } },
    };
    const workflow = workflowWithRootNode(switchNode);
    const switchKey = deriveInstanceKey(appendNode([], "route"));
    const branchKey = deriveInstanceKey(appendBranch([], "route", "default"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    expect(projection.branchDecisions[switchKey]).toBe("default");
    expect(projection.frames[branchKey]).toMatchObject({ status: "completed", instancePath: appendBranch([], "route", "default"), result: { value: "fallback" } });
    expect(continueRootEvents(workflow, projection, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: switchKey, result: { value: "fallback" }, terminalReason: "branch_completed" } },
    ]);
  });

  it("materializes multi-node root scopes sequentially", () => {
    const workflow = workflowWithRootNodes([taskNode("first"), taskNode("second")]);
    const firstKey = deriveInstanceKey(appendNode([], "first"));
    const secondKey = deriveInstanceKey(appendNode([], "second"));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    expect(projection.frames.root).toMatchObject({ status: "running", scope: { first: firstKey } });
    expect(projection.instances[firstKey]).toMatchObject({ status: "ready", readinessSequence: 1 });
    expect(continueRootEvents(workflow, projection, {})).toEqual([]);

    const afterFirst = applySchedulerEvents(projection, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "one" } } },
    ]);
    expect(continueRootEvents(workflow, afterFirst, {})).toEqual([
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondKey, readinessSequence: 2 }) }),
    ]);

    const afterSecond = applySchedulerEvents(afterFirst, [
      ...continueRootEvents(workflow, afterFirst, {}),
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { value: "two" } } },
    ]);
    expect(continueRootEvents(workflow, afterSecond, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: "root", result: {}, terminalReason: "root_completed" } },
    ]);
  });

  it("bootstraps root parallel branch leaf members without completing branch outputs", () => {
    const parallelKey = deriveInstanceKey(appendNode([], "race"));
    const leftBranchKey = deriveInstanceKey(appendBranch([], "race", "left"));
    const rightBranchKey = deriveInstanceKey(appendBranch([], "race", "right"));
    const leftKey = deriveInstanceKey(appendNode(appendBranch([], "race", "left"), "left_task"));
    const rightKey = deriveInstanceKey(appendNode(appendBranch([], "race", "right"), "right_task"));

    const events = bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "race",
      kind: "parallel",
      strategy: "race",
      branches: {
        left: {
          scope: { nodes: [taskNode("left_task")], outputs: {} },
        },
        right: {
          scope: { nodes: [taskNode("right_task")], outputs: {} },
        },
      },
    }));

    expect(events.map(event => event.type)).toEqual([
      "frame.started",
      "frame.started",
      "group.started",
      "frame.started",
      "group.member_ready",
      "instance.ready",
      "frame.started",
      "group.member_ready",
      "instance.ready",
    ]);
    expect(events[0]).toEqual({ type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { race: parallelKey } } });
    expect(events[2]).toEqual({ type: "group.started", payload: { runId: "run_1", groupKey: parallelKey, nodeKey: parallelKey, nodeId: "race", kind: "parallel", strategy: "race" } });
    expect(events[4]).toMatchObject({ type: "group.member_ready", payload: { groupKey: parallelKey, memberKey: leftBranchKey, childFrameKey: leftBranchKey, branchId: "left", readinessSequence: 1 } });
    expect(events[5]).toMatchObject({ type: "instance.ready", payload: { nodeKey: leftKey, nodeId: "left_task", readinessSequence: 1 } });
    expect(events[7]).toMatchObject({ type: "group.member_ready", payload: { groupKey: parallelKey, memberKey: rightBranchKey, childFrameKey: rightBranchKey, branchId: "right", readinessSequence: 2 } });
    expect(events[8]).toMatchObject({ type: "instance.ready", payload: { nodeKey: rightKey, nodeId: "right_task", readinessSequence: 2 } });
  });

  it("materializes pure-before-leaf root parallel branches recursively", () => {
    const withPureFirst = bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        pure: {
          scope: { nodes: [{ id: "check", kind: "assert", condition: { kind: "literal", value: true } }], outputs: {} },
        },
        leaf: {
          scope: { nodes: [taskNode("leaf_task")], outputs: {} },
        },
      },
    }));

    const parallelKey = deriveInstanceKey(appendNode([], "parallel"));
    const pureBranchKey = deriveInstanceKey(appendBranch([], "parallel", "pure"));
    const checkKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "pure"), "check"));
    const leafBranchKey = deriveInstanceKey(appendBranch([], "parallel", "leaf"));
    const leafKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "leaf"), "leaf_task"));

    expect(withPureFirst).toContainEqual({ type: "group.started", payload: { runId: "run_1", groupKey: parallelKey, nodeKey: parallelKey, nodeId: "parallel", kind: "parallel", strategy: "all" } });
    expect(withPureFirst).toContainEqual(expect.objectContaining({ type: "group.member_ready", payload: expect.objectContaining({ memberKey: pureBranchKey, childFrameKey: pureBranchKey, branchId: "pure" }) }));
    expect(withPureFirst).toContainEqual({ type: "frame.completed", payload: { frameKey: checkKey, result: {}, terminalReason: "assert_passed" } });
    expect(withPureFirst).toContainEqual(expect.objectContaining({ type: "group.member_ready", payload: expect.objectContaining({ memberKey: leafBranchKey, childFrameKey: leafBranchKey, branchId: "leaf" }) }));
    expect(withPureFirst).toContainEqual(expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: leafKey, parentFrameKey: leafBranchKey }) }));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), withPureFirst);
    expect(projection.groupMembers[pureBranchKey]).toMatchObject({ status: "ready", childFrameKey: pureBranchKey });
    expect(projection.frames[checkKey]).toMatchObject({ status: "completed", terminalReason: "assert_passed" });
    expect(projection.instances[leafKey]).toMatchObject({ status: "ready", parentFrameKey: leafBranchKey });
  });

  it("continues multi-node root parallel branches sequentially", () => {
    const parallelNode: NodeIR = {
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        branch: {
          scope: {
            nodes: [taskNode("first_task"), taskNode("second_task")],
            outputs: { value: { kind: "ref", path: ["nodes", "second_task", "output", "value"] } },
          },
        },
      },
    };
    const workflow = workflowWithRootNode(parallelNode);
    const branchKey = deriveInstanceKey(appendBranch([], "parallel", "branch"));
    const firstKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "first_task"));
    const secondKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "second_task"));
    const bootstrapped = bootstrapRootEvents("run_1", workflow);

    expect(bootstrapped).toContainEqual(expect.objectContaining({ type: "group.member_ready", payload: expect.objectContaining({ memberKey: branchKey }) }));
    expect(bootstrapped).toContainEqual(expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: firstKey }) }));

    const afterFirst = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapped,
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    expect(continueRootEvents(workflow, afterFirst, {})).toEqual([
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondKey, parentFrameKey: branchKey }) }),
    ]);

    const afterSecond = applySchedulerEvents(afterFirst, [
      ...continueRootEvents(workflow, afterFirst, {}),
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { value: "second" } } },
    ]);
    expect(continueRootEvents(workflow, afterSecond, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: branchKey, result: { value: "second" }, terminalReason: "frame_completed" } },
      { type: "group.member_completed", payload: { memberKey: branchKey, completionSequence: 1, output: { value: "second" } } },
    ]);

    const completedBranch = applySchedulerEvents(afterSecond, continueRootEvents(workflow, afterSecond, {}));
    expect(groupCompletionEvents(completedBranch, deriveInstanceKey(appendNode([], "parallel")))).toEqual([
      { type: "group.completed", payload: { groupKey: deriveInstanceKey(appendNode([], "parallel")), result: { acceptedMemberKeys: [branchKey] } } },
    ]);
  });

  it("completes empty parallel branch members immediately", () => {
    const parallelKey = deriveInstanceKey(appendNode([], "parallel"));
    const branchKey = deriveInstanceKey(appendBranch([], "parallel", "empty"));
    const workflow = workflowWithRootNode({
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        empty: {
          scope: { nodes: [], outputs: { value: { kind: "literal", value: "done" } } },
        },
      },
    });
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflow));

    expect(projection.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "done" } });
    expect(projection.groupMembers[branchKey]).toMatchObject({ status: "completed", output: { value: "done" } });
    expect(groupCompletionEvents(projection, parallelKey)).toEqual([
      { type: "group.completed", payload: { groupKey: parallelKey, result: { acceptedMemberKeys: [branchKey] } } },
    ]);
  });

  it("evaluates multi-node branch outputs with prior root scope", () => {
    const parallelNode: NodeIR = {
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        branch: {
          scope: {
            nodes: [taskNode("first_task"), taskNode("second_task")],
            outputs: {
              value: { kind: "ref", path: ["nodes", "second_task", "output", "value"] },
              rootPrefix: { kind: "ref", path: ["nodes", "prepare", "output", "prefix"] },
            },
          },
        },
      },
    };
    const workflow = workflowWithRootNodes([taskNode("prepare"), parallelNode]);
    const prepareKey = deriveInstanceKey(appendNode([], "prepare"));
    const branchKey = deriveInstanceKey(appendBranch([], "parallel", "branch"));
    const firstKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "first_task"));
    const secondKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "second_task"));
    const afterPrepare = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapRootEvents("run_1", workflow),
      { type: "instance.completed", payload: { nodeKey: prepareKey, output: { prefix: "root" } } },
    ]);
    const afterParallelStart = applySchedulerEvents(afterPrepare, continueRootEvents(workflow, afterPrepare, {}));
    const afterFirst = applySchedulerEvents(afterParallelStart, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    const afterSecondReady = applySchedulerEvents(afterFirst, continueRootEvents(workflow, afterFirst, {}));
    const afterSecond = applySchedulerEvents(afterSecondReady, [
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { value: "second" } } },
    ]);

    expect(continueRootEvents(workflow, afterSecond, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: branchKey, result: { value: "second", rootPrefix: "root" }, terminalReason: "frame_completed" } },
      { type: "group.member_completed", payload: { memberKey: branchKey, completionSequence: 1, output: { value: "second", rootPrefix: "root" } } },
    ]);
  });

  it("propagates multi-node branch child failures and cancellations to frame members", () => {
    const parallelNode: NodeIR = {
      id: "parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        branch: {
          scope: { nodes: [taskNode("first_task"), taskNode("second_task")], outputs: {} },
        },
      },
    };
    const workflow = workflowWithRootNode(parallelNode);
    const branchKey = deriveInstanceKey(appendBranch([], "parallel", "branch"));
    const firstKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "first_task"));
    const secondKey = deriveInstanceKey(appendNode(appendBranch([], "parallel", "branch"), "second_task"));
    const afterFirst = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapRootEvents("run_1", workflow),
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    const afterSecondReady = applySchedulerEvents(afterFirst, continueRootEvents(workflow, afterFirst, {}));

    const failed = applySchedulerEvents(afterSecondReady, [
      { type: "instance.failed", payload: { nodeKey: secondKey, error: { reason: "boom" }, statusReason: "node_failed" } },
    ]);
    expect(continueRootEvents(workflow, failed, {})).toEqual([
      { type: "frame.failed", payload: { frameKey: branchKey, error: { reason: "boom" }, terminalReason: "node_failed" } },
      { type: "group.member_failed", payload: { memberKey: branchKey, error: { reason: "boom" }, terminalReason: "node_failed" } },
    ]);

    const cancelled = applySchedulerEvents(afterSecondReady, [
      { type: "instance.cancelled", payload: { nodeKey: secondKey, cancelReason: "parent_failed" } },
    ]);
    expect(continueRootEvents(workflow, cancelled, {})).toEqual([
      { type: "frame.cancelled", payload: { frameKey: branchKey, cancelReason: "parent_failed" } },
      { type: "group.member_cancelled", payload: { memberKey: branchKey, cancelReason: "parent_failed" } },
    ]);
  });

  it("bootstraps root fanout item members with durable item scope", () => {
    const fanoutKey = deriveInstanceKey(appendNode([], "items"));
    const events = bootstrapRootEvents("run_1", workflowWithRootNode({
      id: "items",
      kind: "fanout",
      strategy: "all",
      over: { kind: "literal", value: ["a", "b"] },
      do: { nodes: [taskNode("item_task")], outputs: {} },
    }), {});

    const readyMembers = events.filter(event => event.type === "group.member_ready");
    expect(events.map(event => event.type)).toEqual([
      "frame.started",
      "frame.started",
      "group.started",
      "frame.started",
      "group.member_ready",
      "instance.ready",
      "frame.started",
      "group.member_ready",
      "instance.ready",
    ]);
    expect(events[2]).toEqual({ type: "group.started", payload: { runId: "run_1", groupKey: fanoutKey, nodeKey: fanoutKey, nodeId: "items", kind: "fanout", strategy: "all" } });
    expect(readyMembers.map(event => event.payload)).toMatchObject([
      { groupKey: fanoutKey, memberKind: "fanout_item", itemIndex: 0, item: "a", readinessSequence: 1 },
      { groupKey: fanoutKey, memberKind: "fanout_item", itemIndex: 1, item: "b", readinessSequence: 2 },
    ]);
  });

  it("fails non-array fanout input durably and materializes pure fanout bodies recursively", () => {
    const nonArray = fanoutNode({ over: { kind: "literal", value: "nope" } });
    const nonLeafDo = fanoutNode({ doNodes: [{ id: "check", kind: "assert", condition: { kind: "literal", value: true } }] });
    const fanoutKey = deriveInstanceKey(appendNode([], "items"));
    const itemFrameKey = deriveInstanceKey(appendFanoutItem([], "items", 0));
    const checkKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 0), "check"));

    expect(bootstrapRootEvents("run_1", workflowWithRootNode(nonArray), {})).toEqual([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { items: fanoutKey } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: fanoutKey }) }),
      { type: "frame.failed", payload: { frameKey: fanoutKey, error: { reason: "fanout_over_not_array" }, terminalReason: "fanout_over_not_array" } },
    ]);
    const pureBodyEvents = bootstrapRootEvents("run_1", workflowWithRootNode(nonLeafDo), {});
    expect(pureBodyEvents).toContainEqual(expect.objectContaining({ type: "group.member_ready", payload: expect.objectContaining({ memberKey: itemFrameKey, childFrameKey: itemFrameKey }) }));
    expect(pureBodyEvents).toContainEqual({ type: "frame.completed", payload: { frameKey: checkKey, result: {}, terminalReason: "assert_passed" } });
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), pureBodyEvents);
    expect(projection.groupMembers[itemFrameKey]).toMatchObject({ status: "ready", childFrameKey: itemFrameKey });
    expect(projection.frames[checkKey]).toMatchObject({ status: "completed", terminalReason: "assert_passed" });
  });

  it("completes empty fanout item members immediately", () => {
    const fanoutKey = deriveInstanceKey(appendNode([], "items"));
    const itemFrameKey = deriveInstanceKey(appendFanoutItem([], "items", 0));
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), bootstrapRootEvents("run_1", workflowWithRootNode(fanoutNode({
      over: { kind: "literal", value: ["a"] },
      doNodes: [],
      doOutputs: { item: { kind: "ref", path: ["fanout", "items", "item"] } },
    })), {}));

    expect(projection.frames[itemFrameKey]).toMatchObject({ status: "completed", result: { item: "a" } });
    expect(projection.groupMembers[itemFrameKey]).toMatchObject({ status: "completed", output: { item: "a" } });
    expect(groupCompletionEvents(projection, fanoutKey)).toEqual([
      { type: "group.completed", payload: { groupKey: fanoutKey, result: { acceptedMemberKeys: [itemFrameKey] } } },
    ]);
  });

  it("continues multi-node root fanout item bodies sequentially", () => {
    const workflow = workflowWithRootNode(fanoutNode({
      doNodes: [taskNode("first"), taskNode("second")],
      doOutputs: { value: { kind: "ref", path: ["nodes", "second", "output", "value"] } },
    }));
    const itemFrameKey = deriveInstanceKey(appendFanoutItem([], "items", 0));
    const firstKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 0), "first"));
    const secondKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", 0), "second"));
    const bootstrapped = bootstrapRootEvents("run_1", workflow, {});

    expect(bootstrapped).toContainEqual(expect.objectContaining({ type: "group.member_ready", payload: expect.objectContaining({ memberKey: itemFrameKey, itemIndex: 0 }) }));
    expect(bootstrapped).toContainEqual(expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: firstKey }) }));

    const afterFirst = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapped,
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    expect(continueRootEvents(workflow, afterFirst, {})).toEqual([
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondKey, parentFrameKey: itemFrameKey }) }),
    ]);

    const afterSecond = applySchedulerEvents(afterFirst, [
      ...continueRootEvents(workflow, afterFirst, {}),
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { value: "second" } } },
    ]);
    expect(continueRootEvents(workflow, afterSecond, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: itemFrameKey, result: { value: "second" }, terminalReason: "frame_completed" } },
      { type: "group.member_completed", payload: { memberKey: itemFrameKey, completionSequence: 1, output: { value: "second" } } },
    ]);
  });

  it("materializes duplicate fanout values as distinct indexed occurrences", () => {
    const events = bootstrapRootEvents("run_1", workflowWithRootNode(fanoutNode({
      over: { kind: "literal", value: ["same", "same"] },
    })), {});
    const members = events.filter(event => event.type === "group.member_ready");

    expect(members.map(event => event.payload)).toMatchObject([
      { memberKey: deriveInstanceKey(appendFanoutItem([], "items", 0)), itemIndex: 0, item: "same" },
      { memberKey: deriveInstanceKey(appendFanoutItem([], "items", 1)), itemIndex: 1, item: "same" },
    ]);
  });

  it("bootstraps and continues a root loop single-leaf iteration", () => {
    const workflow = workflowWithRootNode(loopNode());
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const firstIterationKey = deriveInstanceKey(appendLoopIteration([], "retry", 0));
    const firstNodeKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "loop_task"));
    const secondNodeKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "loop_task"));
    const bootstrapped = bootstrapRootEvents("run_1", workflow, {});

    expect(bootstrapped.map(event => event.type)).toEqual(["frame.started", "frame.started", "frame.loop_advanced", "frame.started", "instance.ready"]);
    expect(bootstrapped[1]).toMatchObject({ type: "frame.started", payload: { frameKey: loopKey, frameKind: "loop", nodeId: "retry" } });
    expect(bootstrapped[2]).toEqual({ type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: false } } });
    expect(bootstrapped[3]).toMatchObject({ type: "frame.started", payload: { frameKey: firstIterationKey, frameKind: "loop_iteration", nodeId: "retry" } });
    expect(bootstrapped[4]).toMatchObject({ type: "instance.ready", payload: { nodeKey: firstNodeKey, readinessSequence: 1 } });

    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapped,
      { type: "instance.completed", payload: { nodeKey: firstNodeKey, output: { done: false } } },
    ]);

    const completeIteration = continueRootEvents(workflow, projection, {});
    expect(completeIteration).toEqual([
      { type: "frame.completed", payload: { frameKey: firstIterationKey, result: { state: { done: false }, stop: false }, terminalReason: "frame_completed" } },
    ]);
    expect(continueRootEvents(workflow, applySchedulerEvents(projection, completeIteration), {})).toEqual([
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: false }, transition: { state: { done: false }, stop: false } } },
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 1, state: { done: false } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: deriveInstanceKey(appendLoopIteration([], "retry", 1)), frameKind: "loop_iteration" }) }),
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondNodeKey, parentFrameKey: deriveInstanceKey(appendLoopIteration([], "retry", 1)), readinessSequence: 2 }) }),
    ]);
  });

  it("rejects a non-durable initial loop state before emitting it", () => {
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const invalidState = { kind: "literal", value: new Date() } as any;

    expect(bootstrapRootEvents("run_1", workflowWithRootNode(loopNode({ state: invalidState })), {})).toEqual([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { retry: loopKey } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: loopKey, frameKind: "loop" }) }),
      {
        type: "frame.failed",
        payload: {
          frameKey: loopKey,
          error: { reason: "expression_failed", message: "Loop node 'retry' initial state is not workflow-admissible: $ is Date." },
          terminalReason: "expression_failed",
        },
      },
    ]);
  });

  it("continues root loop from transition state", () => {
    const workflow = workflowWithRootNode(loopNode());
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const firstNodeKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "loop_task"));
    const secondNodeKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "loop_task"));
    const scope = {};
    const bootstrapped = bootstrapRootEvents("run_1", workflow, scope);
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapped,
      { type: "instance.completed", payload: { nodeKey: firstNodeKey, output: { done: false } } },
      { type: "frame.completed", payload: { frameKey: deriveInstanceKey(appendLoopIteration([], "retry", 0)), result: { state: { done: false }, stop: false }, terminalReason: "frame_completed" } },
    ]);

    expect(continueRootEvents(workflow, projection, scope)).toEqual([
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: false }, transition: { state: { done: false }, stop: false } } },
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 1, state: { done: false } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: deriveInstanceKey(appendLoopIteration([], "retry", 1)), frameKind: "loop_iteration" }) }),
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondNodeKey }) }),
    ]);
  });

  it("materializes pure root loop bodies recursively", () => {
    const nonLeaf = loopNode({ doNodes: [{ id: "check", kind: "assert", condition: { kind: "literal", value: true } }] });
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const iterationKey = deriveInstanceKey(appendLoopIteration([], "retry", 0));
    const checkKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "check"));

    expect(bootstrapRootEvents("run_1", workflowWithRootNode(nonLeaf), {})).toEqual([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { retry: loopKey } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: loopKey, frameKind: "loop" }) }),
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: false } } },
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: iterationKey, frameKind: "loop_iteration" }) }),
      expect.objectContaining({ type: "frame.started", payload: expect.objectContaining({ frameKey: checkKey, frameKind: "node" }) }),
      { type: "frame.completed", payload: { frameKey: checkKey, result: {}, terminalReason: "assert_passed" } },
    ]);
  });

  it("bootstraps and continues multi-node root loop iteration frames", () => {
    const workflow = workflowWithRootNode(loopNode({
      doNodes: [taskNode("first"), taskNode("second")],
      doOutputs: {
        state: {
          kind: "object",
          fields: {
            done: { kind: "ref", path: ["nodes", "second", "output", "done"] },
            value: { kind: "ref", path: ["nodes", "second", "output", "value"] },
          },
        },
        stop: { kind: "ref", path: ["nodes", "second", "output", "done"] },
      },
    }));
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const iterationKey = deriveInstanceKey(appendLoopIteration([], "retry", 0));
    const firstKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "first"));
    const secondKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "second"));
    const bootstrapped = bootstrapRootEvents("run_1", workflow, {});

    expect(bootstrapped.map(event => event.type)).toEqual(["frame.started", "frame.started", "frame.loop_advanced", "frame.started", "instance.ready"]);
    expect(bootstrapped[3]).toMatchObject({ type: "frame.started", payload: { frameKey: iterationKey, frameKind: "loop_iteration", scope: { first: firstKey, second: secondKey } } });
    expect(bootstrapped[4]).toMatchObject({ type: "instance.ready", payload: { nodeKey: firstKey, parentFrameKey: iterationKey } });

    const afterFirst = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapped,
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    expect(continueRootEvents(workflow, afterFirst, {})).toEqual([
      expect.objectContaining({ type: "instance.ready", payload: expect.objectContaining({ nodeKey: secondKey, parentFrameKey: iterationKey }) }),
    ]);

    const afterSecond = applySchedulerEvents(afterFirst, [
      ...continueRootEvents(workflow, afterFirst, {}),
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { done: true, value: "second" } } },
    ]);
    expect(continueRootEvents(workflow, afterSecond, {})).toEqual([
      { type: "frame.completed", payload: { frameKey: iterationKey, result: { state: { done: true, value: "second" }, stop: true }, terminalReason: "frame_completed" } },
    ]);

    const afterIteration = applySchedulerEvents(afterSecond, continueRootEvents(workflow, afterSecond, {}));
    expect(continueRootEvents(workflow, afterIteration, {})).toEqual([
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: true, value: "second" }, transition: { state: { done: true, value: "second" }, stop: true } } },
      { type: "frame.completed", payload: { frameKey: loopKey, result: { done: true, value: "second" }, terminalReason: "stopped" } },
    ]);
  });

  it("evaluates root loop continuation with prior root scope", () => {
    const loop = loopNode({
      doNodes: [taskNode("first"), taskNode("second")],
      doOutputs: {
        state: {
          kind: "object",
          fields: {
            done: { kind: "ref", path: ["nodes", "second", "output", "done"] },
            rootPrefix: { kind: "ref", path: ["nodes", "prepare", "output", "prefix"] },
          },
        },
        stop: { kind: "ref", path: ["nodes", "second", "output", "done"] },
      },
    });
    const workflow = workflowWithRootNodes([taskNode("prepare"), loop]);
    const prepareKey = deriveInstanceKey(appendNode([], "prepare"));
    const loopKey = deriveInstanceKey(appendNode([], "retry"));
    const firstKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "first"));
    const secondKey = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "second"));
    const afterPrepare = applySchedulerEvents(createSchedulerProjection("run_1"), [
      ...bootstrapRootEvents("run_1", workflow),
      { type: "instance.completed", payload: { nodeKey: prepareKey, output: { prefix: "root", stop: true } } },
    ]);
    const afterLoopStart = applySchedulerEvents(afterPrepare, continueRootEvents(workflow, afterPrepare, {}));
    const afterFirst = applySchedulerEvents(afterLoopStart, [
      { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
    ]);
    const afterSecondReady = applySchedulerEvents(afterFirst, continueRootEvents(workflow, afterFirst, {}));
    const afterSecond = applySchedulerEvents(afterSecondReady, [
      { type: "instance.completed", payload: { nodeKey: secondKey, output: { done: true } } },
    ]);
    const afterIteration = applySchedulerEvents(afterSecond, continueRootEvents(workflow, afterSecond, {}));

    expect(continueRootEvents(workflow, afterIteration, {})).toEqual([
      { type: "frame.loop_advanced", payload: { frameKey: loopKey, iter: 0, state: { done: true, rootPrefix: "root" }, transition: { state: { done: true, rootPrefix: "root" }, stop: true } } },
      { type: "frame.completed", payload: { frameKey: loopKey, result: { done: true, rootPrefix: "root" }, terminalReason: "stopped" } },
    ]);
  });
});

function taskNode(id: string): NodeIR {
  return {
    id,
    kind: "task",
    run: { kind: "task_run", input: {}, target: inlineTaskTarget() },
  };
}

function inlineTaskTarget(): Extract<Extract<NodeIR, { kind: "task" }>["run"]["target"], { kind: "inline" }> {
  return { kind: "inline", runtime: "node", source: "async function task() {}" };
}

function fanoutNode(options: {
  over?: Extract<NodeIR, { kind: "fanout" }>["over"];
  doNodes?: NodeIR[];
  doOutputs?: WorkflowIR["root"]["outputs"];
} = {}): NodeIR {
  return {
    id: "items",
    kind: "fanout",
    strategy: "all",
    over: options.over ?? { kind: "literal", value: ["a", "b"] },
    do: { nodes: options.doNodes ?? [taskNode("item_task")], outputs: options.doOutputs ?? {} },
  };
}

type LoopNodeIR = Extract<NodeIR, { kind: "loop" }>;

function loopNode(options: { doNodes?: NodeIR[]; doOutputs?: LoopNodeIR["do"]["outputs"]; state?: LoopNodeIR["state"] } = {}): NodeIR {
  return {
    id: "retry",
    kind: "loop",
    state: options.state ?? { kind: "object", fields: { done: { kind: "literal", value: false } } },
    do: {
      nodes: options.doNodes ?? [taskNode("loop_task")],
      outputs: options.doOutputs ?? {
        state: { kind: "object", fields: { done: { kind: "ref", path: ["nodes", "loop_task", "output", "done"] } } },
        stop: { kind: "ref", path: ["nodes", "loop_task", "output", "done"] },
      },
    },
  };
}

function objectSchema(): SchemaIR {
  return { kind: "object", fields: {}, required: [], additionalProperties: false };
}

function workflowWithRootNode(node: NodeIR): WorkflowIR {
  return workflowWithRootNodes([node]);
}

function workflowWithRootNodes(nodes: NodeIR[]): WorkflowIR {
  return {
    irVersion: 2,
    name: "test",
    inputSchema: objectSchema(),
    root: { nodes, outputs: {} },
    outputs: {},
    agents: {},
    lock: { acpusCoreVersion: "0.0.0", generatedAt: "2026-06-30T00:00:00.000Z", notes: [] },
    diagnostics: [],
  };
}
