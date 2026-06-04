import { describe, expect, it } from "vitest";
import type { FanoutLanePlan } from "../../src/compiler/execution-plan.js";
import { RuntimeErrorCodes } from "../../src/run-index/read-write.js";
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
import { evaluateFanoutLaneCondition, stableItemId } from "../../src/runtime/stage-runner.js";

describe("fanout core", () => {
  it("selects every lane by default", () => {
    const expanded = expandFanoutItems({
      plan: plan([lane("a"), lane("b")]),
      items: [{ id: "item-1" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateFanoutLaneCondition
    });

    expect(expanded.items[0]?.lanes.map((entry) => [entry.id, entry.status])).toEqual([["a", "pending"], ["b", "pending"]]);
    expect(expanded.workUnits.map((unit) => unit.laneId)).toEqual(["a", "b"]);
  });

  it("filters lanes with when and records skipped lanes", () => {
    const expanded = expandFanoutItems({
      plan: plan([
        lane("docs", { source: "item.kind", op: "eq", value: "docs" }),
        lane("code", { source: "item.kind", op: "eq", value: "code" })
      ]),
      items: [{ id: "item-1", kind: "docs" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateFanoutLaneCondition
    });

    expect(expanded.items[0]?.status).toBe("pending");
    expect(expanded.items[0]?.lanes).toMatchObject([
      { id: "docs", status: "pending" },
      { id: "code", status: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES }
    ]);
    expect(expanded.workUnits.map((unit) => unit.laneId)).toEqual(["docs"]);
  });

  it("skips an item when no lane is selected", () => {
    const expanded = expandFanoutItems({
      plan: plan([lane("worker", { source: "item.kind", op: "eq", value: "run" })]),
      items: [{ id: "item-1", kind: "skip" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateFanoutLaneCondition
    });

    expect(expanded.items[0]).toMatchObject({
      status: "skipped",
      skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES,
      lanes: [{ id: "worker", status: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES }]
    });
    expect(expanded.preExecutionItemOutputs.get(0)).toMatchObject({
      status: "skipped",
      laneOutputs: [],
      skippedLanes: [{ laneId: "worker", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES }]
    });
    expect(expanded.workUnits).toHaveLength(0);
  });

  it("treats missing when sources as skipped", () => {
    const expanded = expandFanoutItems({
      plan: plan([lane("worker", { source: "item.missing", op: "neq", value: "x" })]),
      items: [{ id: "item-1" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateFanoutLaneCondition
    });

    expect(expanded.items[0]?.status).toBe("skipped");
    expect(expanded.workUnits).toHaveLength(0);
  });

  it("evaluates any conditions with missing source leaves as false leaves", () => {
    const expanded = expandFanoutItems({
      plan: plan([lane("worker", { any: [
        { source: "item.missing", op: "eq", value: "run" },
        { source: "item.kind", op: "eq", value: "run" }
      ] })]),
      items: [{ id: "item-1", kind: "run" }],
      workflowInput: {},
      outputs: {},
      localForItem: (item) => ({ item }),
      itemIdFor: stableItemId,
      evaluate: evaluateFanoutLaneCondition
    });

    expect(expanded.items[0]?.status).toBe("pending");
    expect(expanded.workUnits.map((unit) => unit.laneId)).toEqual(["worker"]);
  });

  it("includes skipped items in completed counts while retaining skipped counters", () => {
    const skipped: FanoutCoreItem = { id: "item-1", index: 0, status: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES, lanes: [{ id: "worker", actorLabel: "worker", status: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES }] };
    const completed: FanoutCoreItem = { ...completedItem("item-2", 1), status: "completed" };
    const itemOutput = buildFanoutItemOutput({
      item: completed,
      allowPartial: false,
      laneResults: [completedLane("item-2", 1)],
      missingLaneOutput
    });
    const aggregate = buildFanoutStageOutput({
      plan: { allowPartial: false },
      itemOutputs: [itemOutput, skippedOutput(skipped)],
      skippedItems: [{ id: skipped.id, index: skipped.index, status: "skipped", skippedReason: skipped.skippedReason }]
    });
    const summary = deriveFanoutSummary({ candidateItemCount: 2, items: [skipped, completed], allowPartial: false });

    expect(aggregate.status).toBe("completed");
    expect(aggregate.items).toHaveLength(2);
    expect(aggregate.skippedItems).toHaveLength(1);
    expect(aggregate.skippedLanes).toHaveLength(1);
    expect(summary.completedItems).toBe(2);
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
    expect(output.blockedLanes).toEqual([{ laneId: "worker", status: "blocked" }]);
    expect(output.runtimeDiagnostics).toEqual({ errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED });
  });

  it("rejects lane results that do not match the selected item lane", () => {
    const output = buildFanoutItemOutput({
      item: completedItem("item-1", 0),
      allowPartial: false,
      laneResults: [{ ...completedLane("item-2", 1), laneId: "other" }],
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
        { status: "completed", summary: "ok", laneOutputs: [], skippedLanes: [] },
        { status: "blocked", summary: "bad", blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED, laneOutputs: [], skippedLanes: [] }
      ],
      skippedItems: []
    });

    expect(aggregate.status).toBe("blocked");
    expect(aggregate.summary).toContain("blocked");
    expect(aggregate.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED);
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

function plan(lanes: FanoutLanePlan[], policy: Partial<FanoutCorePlan> = {}): FanoutCorePlan {
  return { allowPartial: false, lanes, ...policy };
}

function lane(id: string, when?: FanoutLanePlan["when"]): FanoutLanePlan {
  return {
    id,
    actor: { agent: "worker", mode: "readOnly", label: "worker" },
    promptId: `prompt-${id}`,
    sessionKeyTemplate: id,
    when
  };
}

function completedItem(id: string, index: number): FanoutCoreItem {
  return { id, index, status: "pending", lanes: [{ id: "worker", actorLabel: "worker", status: "pending" }] };
}

function skippedOutput(item: FanoutCoreItem): Record<string, unknown> {
  return {
    status: "skipped",
    itemId: item.id,
    itemIndex: item.index,
    lanes: item.lanes,
    laneOutputs: [],
    skippedLanes: item.lanes.map((lane) => ({ itemId: item.id, itemIndex: item.index, laneId: lane.id, actorLabel: lane.actorLabel, skippedReason: lane.skippedReason }))
  };
}

function completedLane(itemId: string, itemIndex: number): FanoutCoreLaneResult {
  return {
    itemId,
    itemIndex,
    laneId: "worker",
    actorLabel: "worker",
    status: "completed",
    output: { summary: "ok", data: [] },
    outputPath: "lane.json"
  };
}

function blockedLane(itemId: string, itemIndex: number): FanoutCoreLaneResult {
  return {
    itemId,
    itemIndex,
    laneId: "worker",
    actorLabel: "worker",
    status: "blocked",
    output: {
      status: "blocked",
      summary: "failed",
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
    laneId: "worker",
    actorLabel: "worker",
    status: "blocked",
    output: { status: "blocked", summary: "missing", blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT },
    outputPath: "missing.json",
    blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
    errorCode: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
  };
}
