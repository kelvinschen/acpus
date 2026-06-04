import type { FanoutLanePlan } from "../compiler/execution-plan.js";
import { RuntimeErrorCodes, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import type { Actor, ConditionNode } from "../schema/workflow-spec.js";

export type FanoutCorePlan = {
  allowPartial: boolean;
  minCompletedRatio?: number;
  maxBlockedItems?: number;
  lanes: FanoutLanePlan[];
};

export type FanoutCoreItem = NonNullable<StageIndexEntry["fanout"]>["items"][number];
export type FanoutCoreLane = FanoutCoreItem["lanes"][number];

export type FanoutCoreWorkUnit = {
  item: unknown;
  itemIndex: number;
  itemId: string;
  laneId: string;
  actorLabel: string;
  actor: Actor;
  promptId: string;
  outputSchema: FanoutLanePlan["outputSchema"];
  implicitOutputFields: FanoutLanePlan["implicitOutputFields"];
};

export type FanoutCoreLaneResult = {
  itemId: string;
  itemIndex: number;
  laneId: string;
  actorLabel: string;
  status: StageStatus;
  output: Record<string, unknown>;
  outputPath: string;
  blockedReason?: string;
  errorCode?: string;
};

export type FanoutCoreItemOutput = Record<string, unknown>;

type FanoutCoreItemOutputLane = FanoutCoreLane & {
  output?: Record<string, unknown>;
};

export type FanoutCoreAggregate = {
  status: "completed" | "blocked";
  summary: string;
  items: Record<string, unknown>[];
  laneOutputs: FanoutCoreLaneResult[];
  blockedItems: Record<string, unknown>[];
  skippedItems: Array<{ id: string; index: number; status: "skipped"; skippedReason?: string }>;
  skippedLanes: Array<{ itemId: string; itemIndex: number; laneId: string; actorLabel: string; skippedReason?: string }>;
  blockedReason?: string;
};

export type FanoutCoreCascadeOutput = {
  item: FanoutCoreItem;
  output: FanoutCoreItemOutput;
};

export function expandFanoutItems(input: {
  plan: FanoutCorePlan;
  items: unknown[];
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  localForItem: (item: unknown, itemIndex: number) => Record<string, unknown>;
  itemIdFor: (item: unknown, itemIndex: number) => string;
  evaluate: (condition: ConditionNode, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>, local: Record<string, unknown>) => boolean;
}): { items: FanoutCoreItem[]; workUnits: FanoutCoreWorkUnit[]; preExecutionItemOutputs: Map<number, Record<string, unknown>> } {
  const fanoutItems: FanoutCoreItem[] = [];
  const workUnits: FanoutCoreWorkUnit[] = [];
  const preExecutionItemOutputs = new Map<number, Record<string, unknown>>();

  for (let itemIndex = 0; itemIndex < input.items.length; itemIndex += 1) {
    const item = input.items[itemIndex];
    const itemId = input.itemIdFor(item, itemIndex);
    const local = input.localForItem(item, itemIndex);
    const lanes = input.plan.lanes.map((lane) => {
      const selected = !lane.when || input.evaluate(lane.when, input.outputs, input.workflowInput, local);
      return {
        id: lane.id,
        actorLabel: actorLabel(lane.actor, lane.id),
        status: selected ? "pending" as StageStatus : "skipped" as StageStatus,
        skippedReason: selected ? undefined : RuntimeErrorCodes.NO_SELECTED_LANES
      };
    });
    const selectedLanes = lanes.filter((lane) => lane.status !== "skipped");

    if (selectedLanes.length === 0) {
      const itemOutput = {
        status: "skipped",
        summary: `Fanout item ${itemId} selected no lanes.`,
        itemId,
        itemIndex,
        lanes,
        laneOutputs: [],
        skippedLanes: lanes.map((lane) => ({
          itemId,
          itemIndex,
          laneId: lane.id,
          actorLabel: lane.actorLabel,
          skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES
        })),
        skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES
      };
      preExecutionItemOutputs.set(itemIndex, itemOutput);
      fanoutItems.push({ id: itemId, index: itemIndex, status: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES, lanes });
      continue;
    }

    for (const lane of input.plan.lanes.filter((lane) => selectedLanes.some((selected) => selected.id === lane.id))) {
      workUnits.push({
        item,
        itemIndex,
        itemId,
        laneId: lane.id,
        actorLabel: actorLabel(lane.actor, lane.id),
        actor: lane.actor,
        promptId: lane.promptId,
        outputSchema: lane.outputSchema,
        implicitOutputFields: lane.implicitOutputFields
      });
    }
    fanoutItems.push({ id: itemId, index: itemIndex, status: "pending", lanes });
  }

  return { items: fanoutItems, workUnits, preExecutionItemOutputs };
}

function actorLabel(actor: Actor, fallback: string): string {
  return actor.label ?? actor.agent ?? fallback;
}

export function fanoutLaneSetStatus(lanes: Array<{ status: StageStatus }>): StageStatus {
  const selected = lanes.filter((lane) => lane.status !== "skipped");
  if (selected.some((lane) => lane.status === "running")) return "running";
  if (selected.some((lane) => lane.status === "pending" || lane.status === "ready")) return "ready";
  if (selected.some((lane) => lane.status === "failed")) return "failed";
  if (selected.some((lane) => lane.status === "blocked")) return "blocked";
  if (selected.length === 0) return "skipped";
  return "completed";
}

export function fanoutItemStatus(item: Pick<FanoutCoreItem, "status" | "lanes">): StageStatus {
  if (item.status === "blocked" || item.status === "skipped") return item.status;
  return fanoutLaneSetStatus(item.lanes);
}

export function fanoutTransientStatus(items: FanoutCoreItem[]): StageStatus {
  return hasRunningFanoutItems(items) ? "running" : "ready";
}

export function hasRunningFanoutItems(items: FanoutCoreItem[]): boolean {
  return items.some((item) => item.status === "running" || item.lanes.some((lane) => lane.status === "running"));
}

export function hasQueuedFanoutItems(items: FanoutCoreItem[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "ready" || item.lanes.some((lane) => lane.status === "pending" || lane.status === "ready"));
}

export function fanoutItemCounts(items: FanoutCoreItem[]): Pick<NonNullable<StageIndexEntry["fanout"]>, "completedItems" | "blockedItems" | "failedItems"> {
  return {
    completedItems: items.filter((item) => item.status === "completed" || item.status === "skipped").length,
    blockedItems: items.filter((item) => item.status === "blocked").length,
    failedItems: items.filter((item) => item.status === "failed").length
  };
}

export function countFanoutWorkUnits(items: FanoutCoreItem[]): number {
  return items.reduce((total, item) => total + item.lanes.filter((lane) => lane.status !== "skipped").length, 0);
}

export function deriveFanoutSummary(input: {
  candidateItemCount: number;
  items: FanoutCoreItem[];
  allowPartial: boolean;
}): NonNullable<StageIndexEntry["fanout"]> {
  return {
    totalItems: input.candidateItemCount,
    ...fanoutItemCounts(input.items),
    skippedItems: input.items.filter((item) => item.status === "skipped").length,
    workUnits: countFanoutWorkUnits(input.items),
    allowPartial: input.allowPartial,
    items: input.items
  };
}

export function buildFanoutItemOutput(input: {
  item: FanoutCoreItem;
  laneResults: FanoutCoreLaneResult[];
  allowPartial: boolean;
  existingItemOutput?: Record<string, unknown>;
  missingLaneOutput: (item: FanoutCoreItem, lane: FanoutCoreLane) => FanoutCoreLaneResult;
}): Record<string, unknown> {
  const item = input.item;
  const mismatch = mismatchedLaneResult(item, input.laneResults);
  if (mismatch) {
    return {
      status: "blocked",
      summary: `Fanout item ${item.id} received a lane result for ${mismatch.itemId}/${mismatch.laneId}, which is not selected for this item.`,
      blockedReason: RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH,
      errorCode: RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH,
      itemId: item.id,
      itemIndex: item.index,
      lanes: item.lanes,
      laneOutputs: [],
      skippedLanes: skippedLaneSummaries(item),
      runtimeDiagnostics: {
        errorCode: RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH,
        expectedItemId: item.id,
        resultItemId: mismatch.itemId,
        resultLaneId: mismatch.laneId
      }
    };
  }
  if ((item.status === "blocked" || item.status === "failed") && item.lanes.filter((lane) => lane.status !== "skipped").length === 0) {
    const blockedReason = item.outputPath
      ? item.blockedReason ?? item.errorCode ?? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED
      : item.blockedReason ?? item.errorCode ?? RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT;
    return {
      status: "blocked",
      summary: input.existingItemOutput?.summary ?? item.errorMessage ?? `Fanout item ${item.id} blocked before lane execution.`,
      blockedReason,
      errorCode: blockedReason,
      itemId: item.id,
      itemIndex: item.index,
      lanes: item.lanes,
      laneOutputs: [],
      skippedLanes: skippedLaneSummaries(item)
    };
  }
  if (item.status === "skipped") {
    return {
      status: "skipped",
      summary: `Fanout item ${item.id} selected no lanes.`,
      itemId: item.id,
      itemIndex: item.index,
      lanes: item.lanes,
      laneOutputs: [],
      skippedLanes: skippedLaneSummaries(item),
      skippedReason: item.skippedReason ?? RuntimeErrorCodes.NO_SELECTED_LANES
    };
  }

  const resultByLane = new Map(input.laneResults.map((result) => [result.laneId, result]));
  const lanes: FanoutCoreItemOutputLane[] = item.lanes.map((lane) => {
    if (lane.status === "skipped") return lane;
    const result = resultByLane.get(lane.id) ?? input.missingLaneOutput(item, lane);
    return {
      id: lane.id,
      actorLabel: lane.actorLabel,
      status: result.status,
      output: result.output,
      outputPath: result.outputPath,
      blockedReason: result.blockedReason ?? stringField(result.output, "blockedReason") ?? lane.blockedReason,
      errorCode: result.errorCode ?? lane.errorCode
    };
  });
  const laneOutputs = lanes
    .filter((lane) => lane.status !== "skipped")
    .map((lane) => ({
      itemId: item.id,
      itemIndex: item.index,
      laneId: lane.id,
      actorLabel: lane.actorLabel,
      output: lane.output,
      outputPath: lane.outputPath,
      status: lane.status,
      blockedReason: lane.blockedReason,
      errorCode: lane.errorCode
    }));
  const skippedLanes = skippedLaneSummaries({ ...item, lanes });
  const blockedLaneOutputs = laneOutputs.filter((lane) => lane.status !== "completed");
  const partial = blockedLaneOutputs.length > 0 && input.allowPartial;
  const status = blockedLaneOutputs.length > 0 && !input.allowPartial ? "blocked" : "completed";
  const firstBlockedLane = blockedLaneOutputs[0];
  const firstBlockedOutput = objectRecord(firstBlockedLane?.output);
  const errorCode = firstBlockedLane?.errorCode ?? stringField(firstBlockedOutput, "errorCode") ?? stringField(firstBlockedOutput, "blockedReason") ?? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED;
  const blockedReason = firstBlockedLane?.blockedReason ?? stringField(firstBlockedOutput, "blockedReason") ?? errorCode;
  return {
    status,
    summary: `Fanout item ${item.id} completed ${laneOutputs.length - blockedLaneOutputs.length}/${laneOutputs.length} selected lane(s).`,
    itemId: item.id,
    itemIndex: item.index,
    lanes,
    laneOutputs,
    skippedLanes,
    partial,
    blockedLanes: blockedLaneOutputs.map((lane) => ({ laneId: lane.laneId, status: lane.status })),
    blockedReason: blockedLaneOutputs.length > 0 ? blockedReason : undefined,
    errorCode: blockedLaneOutputs.length > 0 ? errorCode : undefined,
    runtimeDiagnostics: blockedLaneOutputs.length > 0 ? firstBlockedOutput?.runtimeDiagnostics : undefined
  };
}

export function buildFanoutStageOutput(input: {
  plan: Pick<FanoutCorePlan, "allowPartial" | "minCompletedRatio" | "maxBlockedItems">;
  itemOutputs: Record<string, unknown>[];
  skippedItems: Array<{ id: string; index: number; status: "skipped"; skippedReason?: string }>;
}): FanoutCoreAggregate {
  const laneOutputs = input.itemOutputs.flatMap((item) => Array.isArray(item.laneOutputs) ? item.laneOutputs as FanoutCoreLaneResult[] : []);
  const skippedLanes = input.itemOutputs.flatMap((item) => Array.isArray(item.skippedLanes) ? item.skippedLanes as FanoutCoreAggregate["skippedLanes"] : []);
  const blockedItems = input.itemOutputs.filter((output) => output.status === "blocked" || output.partial === true);
  const nonCompletedItems = input.itemOutputs.filter((output) => output.status !== "completed" && output.status !== "skipped" || output.partial === true);
  const completedForRatio = input.itemOutputs.filter((output) => (output.status === "completed" || output.status === "skipped") && (input.plan.allowPartial || output.partial !== true)).length;
  const ratio = input.itemOutputs.length === 0 ? 1 : completedForRatio / input.itemOutputs.length;
  const partialAllowed = input.plan.allowPartial
    && (input.plan.minCompletedRatio == null || ratio >= input.plan.minCompletedRatio)
    && (input.plan.maxBlockedItems == null || nonCompletedItems.length <= input.plan.maxBlockedItems);
  const status = nonCompletedItems.length > 0 && !partialAllowed ? "blocked" : "completed";
  const firstBlockedReason = firstBlockedItemReason(nonCompletedItems);
  return {
    status,
    summary: `Fanout ${status} with ${input.itemOutputs.length} item output(s), ${input.skippedItems.length} skipped item(s), and ${skippedLanes.length} skipped lane(s).`,
    items: input.itemOutputs,
    laneOutputs,
    blockedItems,
    skippedItems: input.skippedItems,
    skippedLanes,
    blockedReason: status === "blocked" ? firstBlockedReason ?? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED : undefined
  };
}

export function cascadeBlockFanoutItems(input: {
  items: FanoutCoreItem[];
  now: string;
  outputPathForItem?: (item: FanoutCoreItem) => string | undefined;
}): { items: FanoutCoreItem[]; outputs: FanoutCoreCascadeOutput[] } {
  const outputs: FanoutCoreCascadeOutput[] = [];
  const items = input.items.map((item) => {
    if (item.status !== "pending" && item.status !== "ready") return item;
    const lanes = item.lanes.map((lane) => lane.status === "skipped" ? lane : {
      ...lane,
      status: "blocked" as StageStatus,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      completedAt: input.now
    });
    const output: FanoutCoreItemOutput = {
      status: "blocked",
      summary: `Fanout item ${item.id} was not started because an earlier item blocked and partial fanout is disabled.`,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      itemId: item.id,
      itemIndex: item.index,
      lanes,
      laneOutputs: [],
      skippedLanes: skippedLaneSummaries({ ...item, lanes })
    };
    const blockedItem: FanoutCoreItem = {
      ...item,
      status: "blocked",
      outputPath: input.outputPathForItem?.(item) ?? item.outputPath,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      completedAt: input.now,
      lanes
    };
    outputs.push({ item: blockedItem, output });
    return blockedItem;
  });
  return { items, outputs };
}

function skippedLaneSummaries(item: Pick<FanoutCoreItem, "id" | "index" | "lanes">): FanoutCoreAggregate["skippedLanes"] {
  return item.lanes
    .filter((lane) => lane.status === "skipped")
    .map((lane) => ({
      itemId: item.id,
      itemIndex: item.index,
      laneId: lane.id,
      actorLabel: lane.actorLabel,
      skippedReason: lane.skippedReason ?? RuntimeErrorCodes.NO_SELECTED_LANES
    }));
}

function mismatchedLaneResult(item: FanoutCoreItem, results: FanoutCoreLaneResult[]): FanoutCoreLaneResult | undefined {
  const laneKeys = new Set(item.lanes.map((lane) => lane.id));
  return results.find((result) => result.itemId !== item.id || result.itemIndex !== item.index || !laneKeys.has(result.laneId));
}

function firstBlockedItemReason(items: Record<string, unknown>[]): string | undefined {
  for (const item of items) {
    const errorCode = stringField(item, "errorCode");
    const blockedReason = stringField(item, "blockedReason");
    if (errorCode) return errorCode;
    if (blockedReason) return blockedReason;
    const blockedLanes = Array.isArray(item.blockedLanes) ? item.blockedLanes : [];
    for (const lane of blockedLanes) {
      if (!lane || typeof lane !== "object" || Array.isArray(lane)) continue;
      const laneRecord = lane as Record<string, unknown>;
      const laneCode = stringField(laneRecord, "errorCode") ?? stringField(laneRecord, "blockedReason");
      if (laneCode) return laneCode;
    }
  }
  return undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
