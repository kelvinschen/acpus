import { describe, expect, it } from "vitest";
import type { FanoutLaneGroupPlan } from "../../src/compiler/execution-plan.js";
import { RuntimeErrorCodes, type StageStatus } from "../../src/run-index/read-write.js";
import {
  buildFanoutItemOutput,
  buildFanoutStageOutput,
  cascadeBlockFanoutItems,
  deriveFanoutSummary,
  expandFanoutItems,
  type FanoutCoreItem,
  type FanoutCoreLaneResult,
  type FanoutCorePlan
} from "../../src/runtime/fanout-core.js";
import { evaluateCondition, stableItemId } from "../../src/runtime/stage-runner.js";

describe("fanout core", () => {
  it("blocks oneOf items with multiple matching lanes", () => {
    const expanded = expandFanoutItems({
      plan: plan([{ id: "route", mode: "oneOf", lanes: [
        lane("a", { source: "item.kind", op: "eq", value: "both" }),
        lane("b", { source: "item.kind", op: "eq", value: "both" })
      ] }]),
      items: [{ id: "item-1", kind: "both" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateCondition
    });

    expect(expanded.items[0]).toMatchObject({
      status: "blocked",
      errorCode: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED
    });
    expect(expanded.workUnits).toHaveLength(0);
  });

  it("blocks oneOf items with no matching lane and no default", () => {
    const expanded = expandFanoutItems({
      plan: plan([{ id: "route", mode: "oneOf", lanes: [lane("a", { source: "item.kind", op: "eq", value: "a" })] }]),
      items: [{ id: "item-1", kind: "b" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateCondition
    });

    expect(expanded.items[0]?.errorCode).toBe(RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED);
    expect(expanded.workUnits).toHaveLength(0);
  });

  it("skips all-group items with no selected lanes", () => {
    const expanded = expandFanoutItems({
      plan: plan([{ id: "work", mode: "all", lanes: [lane("worker", { source: "item.kind", op: "eq", value: "run" })] }]),
      items: [{ id: "item-1", kind: "skip" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateCondition
    });

    expect(expanded.items[0]).toMatchObject({
      status: "skipped",
      skippedReason: RuntimeErrorCodes.NO_MATCHING_LANES
    });
    expect(expanded.workUnits).toHaveLength(0);
  });

  it("excludes skipped items from aggregate items while retaining candidate total", () => {
    const skipped: FanoutCoreItem = { id: "item-1", index: 0, status: "skipped", skippedReason: RuntimeErrorCodes.NO_MATCHING_LANES, groups: [] };
    const completed = completedItem("item-2", 1);
    const itemOutput = buildFanoutItemOutput({
      item: completed,
      allowPartial: false,
      laneResults: [completedLane("item-2", 1)],
      missingLaneOutput
    });
    const aggregate = buildFanoutStageOutput({
      plan: { allowPartial: false },
      itemOutputs: [itemOutput],
      skippedItems: [{ id: skipped.id, index: skipped.index, status: "skipped", skippedReason: skipped.skippedReason }]
    });
    const summary = deriveFanoutSummary({ candidateItemCount: 2, items: [skipped, completed], allowPartial: false });

    expect(aggregate.items).toHaveLength(1);
    expect(aggregate.skippedItems).toHaveLength(1);
    expect(summary.totalItems).toBe(2);
    expect(summary.skippedItems).toBe(1);
  });

  it("applies partial policy thresholds", () => {
    const completeOutput = buildFanoutItemOutput({ item: completedItem("item-1", 0), allowPartial: true, laneResults: [completedLane("item-1", 0)], missingLaneOutput });
    const partialOutput = buildFanoutItemOutput({ item: completedItem("item-2", 1), allowPartial: true, laneResults: [blockedLane("item-2", 1)], missingLaneOutput });

    expect(buildFanoutStageOutput({
      plan: { allowPartial: true, minCompletedRatio: 1, maxBlockedItems: 1 },
      itemOutputs: [completeOutput, partialOutput],
      skippedItems: []
    }).status).toBe("completed");
    expect(buildFanoutStageOutput({
      plan: { allowPartial: true, minCompletedRatio: 1, maxBlockedItems: 0 },
      itemOutputs: [completeOutput, partialOutput],
      skippedItems: []
    }).status).toBe("blocked");
  });

  it("propagates blocked lane diagnostics into item output", () => {
    const output = buildFanoutItemOutput({
      item: completedItem("item-1", 0),
      allowPartial: false,
      laneResults: [blockedLane("item-1", 0)],
      missingLaneOutput
    });

    expect(output.status).toBe("blocked");
    expect(output.blockedReason).toBe(RuntimeErrorCodes.AGENT_TURN_FAILED);
    expect(output.blockedLanes).toEqual([{ groupId: "work", laneId: "worker", status: "blocked" }]);
    expect(output.runtimeDiagnostics).toEqual({ errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED });
  });

  it("rejects lane results that do not match the selected item lane", () => {
    const output = buildFanoutItemOutput({
      item: completedItem("item-1", 0),
      allowPartial: false,
      laneResults: [{ ...completedLane("item-2", 1), groupId: "other" }],
      missingLaneOutput
    });

    expect(output).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH,
      errorCode: RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH
    });
  });

  it("uses the first specific blocked item reason for blocked stage aggregates", () => {
    const aggregate = buildFanoutStageOutput({
      plan: { allowPartial: false },
      itemOutputs: [
        { status: "completed", summary: "ok", artifacts: [], nextFocus: "reduce", laneOutputs: [] },
        { status: "blocked", summary: "bad", artifacts: [], nextFocus: "diagnose", blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED, laneOutputs: [] }
      ],
      skippedItems: []
    });

    expect(aggregate.status).toBe("blocked");
    expect(aggregate.summary).toContain("blocked");
    expect(aggregate.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED);
  });

  it("prioritizes failed over blocked when deriving group and item status", () => {
    const item: FanoutCoreItem = {
      id: "item-1",
      index: 0,
      status: "pending",
      groups: [{ id: "work", mode: "all", status: "pending", lanes: [
        { id: "a", roleName: "worker", status: "blocked" },
        { id: "b", roleName: "worker", status: "failed" }
      ] }]
    };

    expect(buildFanoutItemOutput({
      item,
      allowPartial: false,
      laneResults: [
        { ...blockedLane("item-1", 0), laneId: "a" },
        { ...blockedLane("item-1", 0), laneId: "b", status: "failed" }
      ],
      missingLaneOutput
    }).groups).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("does not mark mixed skipped and completed lane groups as skipped", () => {
    expect(buildFanoutItemOutput({
      item: {
        id: "item-1",
        index: 0,
        status: "pending",
        groups: [{ id: "work", mode: "all", status: "pending", lanes: [
          { id: "a", roleName: "worker", status: "pending" },
          { id: "b", roleName: "worker", status: "pending" }
        ] }]
      },
      allowPartial: false,
      laneResults: [
        { ...completedLane("item-1", 0), laneId: "a" },
        { ...completedLane("item-1", 0), laneId: "b", status: "skipped" }
      ],
      missingLaneOutput
    }).groups).toContainEqual(expect.objectContaining({ status: "completed" }));
  });

  it("keeps blockedReason and errorCode independently sourced when both are present", () => {
    const output = buildFanoutItemOutput({
      item: completedItem("item-1", 0),
      allowPartial: false,
      laneResults: [{
        ...blockedLane("item-1", 0),
        blockedReason: "human-blocked-reason",
        errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED,
        output: {
          status: "blocked",
          summary: "failed",
          artifacts: [],
          nextFocus: "diagnose",
          blockedReason: "human-blocked-reason",
          errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED
        }
      }],
      missingLaneOutput
    });

    expect(output.blockedReason).toBe("human-blocked-reason");
    expect(output.errorCode).toBe(RuntimeErrorCodes.AGENT_TURN_FAILED);
  });

  it("cascade-blocks queued items with a reusable pure core helper", () => {
    const started: FanoutCoreItem = { ...completedItem("item-1", 0), status: "completed" };
    const queued = completedItem("item-2", 1);
    const cascaded = cascadeBlockFanoutItems({
      items: [started, queued],
      now: "2026-06-02T00:00:00.000Z",
      outputPathForItem: (item) => `outputs/fanout/${item.id}.json`
    });

    expect(cascaded.items[0]?.status).toBe("completed");
    expect(cascaded.items[1]).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      outputPath: "outputs/fanout/item-2.json"
    });
    expect(cascaded.outputs).toHaveLength(1);
    expect(cascaded.outputs[0]?.output).toMatchObject({
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED
    });
  });
});

function plan(laneGroups: FanoutLaneGroupPlan[], policy: Partial<FanoutCorePlan> = {}): FanoutCorePlan {
  return { allowPartial: false, laneGroups, ...policy };
}

function lane(id: string, when?: FanoutLaneGroupPlan["lanes"][number]["when"]): FanoutLaneGroupPlan["lanes"][number] {
  return {
    id,
    roleName: "worker",
    promptId: `prompt-${id}`,
    contract: { name: "base" },
    sessionKeyTemplate: id,
    when
  };
}

function completedItem(id: string, index: number): FanoutCoreItem {
  return { id, index, status: "pending", groups: [{ id: "work", mode: "all", status: "pending", lanes: [{ id: "worker", roleName: "worker", status: "pending" }] }] };
}

function completedLane(itemId: string, itemIndex: number): FanoutCoreLaneResult {
  return {
    itemId,
    itemIndex,
    groupId: "work",
    laneId: "worker",
    roleName: "worker",
    status: "completed",
    output: { status: "completed", summary: "ok", artifacts: [], nextFocus: "reduce" },
    outputPath: "lane.json"
  };
}

function blockedLane(itemId: string, itemIndex: number): FanoutCoreLaneResult {
  return {
    itemId,
    itemIndex,
    groupId: "work",
    laneId: "worker",
    roleName: "worker",
    status: "blocked",
    output: {
      status: "blocked",
      summary: "failed",
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: RuntimeErrorCodes.AGENT_TURN_FAILED,
      runtimeDiagnostics: { errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED }
    },
    outputPath: "lane.json",
    blockedReason: RuntimeErrorCodes.AGENT_TURN_FAILED,
    errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED
  };
}

function missingLaneOutput(item: FanoutCoreItem): FanoutCoreLaneResult {
  return {
    itemId: item.id,
    itemIndex: item.index,
    groupId: "work",
    laneId: "worker",
    roleName: "worker",
    status: "blocked",
    output: { status: "blocked", summary: "missing", artifacts: [], nextFocus: "diagnose", blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT },
    outputPath: "missing.json",
    blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
    errorCode: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
  };
}
