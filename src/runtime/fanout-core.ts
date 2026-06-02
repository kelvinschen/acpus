import type { FanoutLaneGroupPlan } from "../compiler/execution-plan.js";
import { RuntimeErrorCodes, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import type { ConditionNode } from "../schema/workflow-spec.js";

export type FanoutCorePlan = {
  allowPartial: boolean;
  minCompletedRatio?: number;
  maxBlockedItems?: number;
  laneGroups: FanoutLaneGroupPlan[];
};

export type FanoutCoreItem = NonNullable<StageIndexEntry["fanout"]>["items"][number];
export type FanoutCoreGroup = NonNullable<FanoutCoreItem["groups"]>[number];
export type FanoutCoreLane = FanoutCoreGroup["lanes"][number];

export type FanoutCoreWorkUnit = {
  item: unknown;
  itemIndex: number;
  itemId: string;
  groupId: string;
  laneId: string;
  roleName: string;
  promptId: string;
  contract: FanoutLaneGroupPlan["lanes"][number]["contract"];
};

export type FanoutCoreLaneResult = {
  itemId: string;
  itemIndex: number;
  groupId: string;
  laneId: string;
  roleName: string;
  status: StageStatus;
  output: Record<string, unknown>;
  outputPath: string;
  blockedReason?: string;
  errorCode?: string;
};

export type FanoutCoreAggregate = {
  status: "completed" | "blocked";
  summary: string;
  items: Record<string, unknown>[];
  laneOutputs: FanoutCoreLaneResult[];
  blockedItems: Record<string, unknown>[];
  skippedItems: Array<{ id: string; index: number; status: "skipped"; skippedReason?: string }>;
  artifacts: unknown[];
  nextFocus: string;
  blockedReason?: string;
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
    const groups: FanoutCoreGroup[] = [];
    const selectionErrors: string[] = [];
    const itemWorkUnits: FanoutCoreWorkUnit[] = [];
    const local = input.localForItem(item, itemIndex);

    for (const group of input.plan.laneGroups) {
      const matched = group.lanes.filter((lane) => lane.default !== true && (!lane.when || input.evaluate(lane.when, input.outputs, input.workflowInput, local)));
      const defaultLane = group.lanes.find((lane) => lane.default === true);
      const selected = group.mode === "all"
        ? matched
        : matched.length === 1 ? matched : matched.length === 0 && defaultLane ? [defaultLane] : [];
      if (group.mode === "oneOf" && matched.length > 1) {
        selectionErrors.push(`oneOf group ${group.id} matched multiple lanes: ${matched.map((lane) => lane.id).join(", ")}`);
      } else if (group.mode === "oneOf" && selected.length === 0) {
        selectionErrors.push(`oneOf group ${group.id} matched no lane and has no default.`);
      }
      if (selected.length === 0) continue;
      groups.push({
        id: group.id,
        mode: group.mode,
        status: "pending",
        lanes: selected.map((lane) => ({ id: lane.id, roleName: lane.roleName, status: "pending" }))
      });
      for (const lane of selected) {
        itemWorkUnits.push({
          item,
          itemIndex,
          itemId,
          groupId: group.id,
          laneId: lane.id,
          roleName: lane.roleName,
          promptId: lane.promptId,
          contract: lane.contract
        });
      }
    }

    if (selectionErrors.length > 0) {
      const itemOutput = {
        status: "blocked",
        summary: `Fanout item ${itemId} lane selection failed.`,
        artifacts: [],
        nextFocus: "diagnose",
        itemId,
        itemIndex,
        groups,
        laneOutputs: [],
        blockedReason: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED,
        errorCode: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED,
        errorMessage: selectionErrors.join(" ")
      };
      preExecutionItemOutputs.set(itemIndex, itemOutput);
      fanoutItems.push({ id: itemId, index: itemIndex, status: "blocked", blockedReason: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED, errorCode: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED, errorMessage: selectionErrors.join(" "), groups });
    } else if (groups.length === 0) {
      preExecutionItemOutputs.set(itemIndex, {
        status: "skipped",
        summary: `Fanout item ${itemId} produced no matching lanes.`,
        artifacts: [],
        nextFocus: "reduce",
        itemId,
        itemIndex,
        groups: [],
        laneOutputs: [],
        skippedReason: RuntimeErrorCodes.NO_MATCHING_LANES
      });
      fanoutItems.push({ id: itemId, index: itemIndex, status: "skipped", skippedReason: RuntimeErrorCodes.NO_MATCHING_LANES, groups: [] });
    } else {
      workUnits.push(...itemWorkUnits);
      fanoutItems.push({ id: itemId, index: itemIndex, status: "pending", groups });
    }
  }

  return { items: fanoutItems, workUnits, preExecutionItemOutputs };
}

export function fanoutGroupStatus(lanes: Array<{ status: StageStatus }>): StageStatus {
  if (lanes.some((lane) => lane.status === "running")) return "running";
  if (lanes.some((lane) => lane.status === "pending" || lane.status === "ready")) return "ready";
  if (lanes.some((lane) => lane.status === "blocked")) return "blocked";
  if (lanes.some((lane) => lane.status === "failed")) return "failed";
  return "completed";
}

export function fanoutItemStatus(item: Pick<FanoutCoreItem, "status" | "groups">): StageStatus {
  if (item.status === "blocked" || item.status === "skipped") return item.status;
  const groups = item.groups ?? [];
  if (groups.some((group) => group.status === "running")) return "running";
  if (groups.some((group) => group.status === "pending" || group.status === "ready")) return "ready";
  if (groups.some((group) => group.status === "blocked")) return "blocked";
  if (groups.some((group) => group.status === "failed")) return "failed";
  return "completed";
}

export function fanoutTransientStatus(items: FanoutCoreItem[]): StageStatus {
  return hasRunningFanoutItems(items) ? "running" : "ready";
}

export function hasRunningFanoutItems(items: FanoutCoreItem[]): boolean {
  return items.some((item) => item.status === "running" || item.groups?.some((group) => group.lanes.some((lane) => lane.status === "running")));
}

export function hasQueuedFanoutItems(items: FanoutCoreItem[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "ready" || item.groups?.some((group) => group.lanes.some((lane) => lane.status === "pending" || lane.status === "ready")));
}

export function fanoutItemCounts(items: FanoutCoreItem[]): Pick<NonNullable<StageIndexEntry["fanout"]>, "completedItems" | "blockedItems" | "failedItems"> {
  return {
    completedItems: items.filter((item) => item.status === "completed").length,
    blockedItems: items.filter((item) => item.status === "blocked").length,
    failedItems: items.filter((item) => item.status === "failed").length
  };
}

export function countFanoutWorkUnits(items: FanoutCoreItem[]): number {
  return items.reduce((total, item) => total + (item.groups ?? []).reduce((groupTotal, group) => groupTotal + group.lanes.length, 0), 0);
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
  missingLaneOutput: (item: FanoutCoreItem, group: FanoutCoreGroup, lane: FanoutCoreLane) => FanoutCoreLaneResult;
}): Record<string, unknown> {
  const item = input.item;
  if (item.status === "blocked" && item.errorCode === RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED) {
    return {
      status: "blocked",
      summary: item.errorMessage ?? `Fanout item ${item.id} lane selection failed.`,
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED,
      errorCode: RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED,
      errorMessage: item.errorMessage,
      itemId: item.id,
      itemIndex: item.index,
      groups: item.groups ?? [],
      laneOutputs: []
    };
  }
  if ((item.status === "blocked" || item.status === "failed") && (!item.groups || item.groups.length === 0)) {
    return {
      ...(input.existingItemOutput ?? {}),
      status: "blocked",
      summary: input.existingItemOutput?.summary ?? item.errorMessage ?? `Fanout item ${item.id} blocked before lane execution.`,
      artifacts: Array.isArray(input.existingItemOutput?.artifacts) ? input.existingItemOutput.artifacts : [],
      nextFocus: typeof input.existingItemOutput?.nextFocus === "string" ? input.existingItemOutput.nextFocus : "diagnose",
      blockedReason: item.outputPath ? item.blockedReason ?? item.errorCode ?? RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED : RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
      itemId: item.id,
      itemIndex: item.index,
      groups: [],
      laneOutputs: []
    };
  }

  const resultByLane = new Map(input.laneResults.map((result) => [`${result.groupId}:${result.laneId}`, result]));
  const groups = (item.groups ?? []).map((group) => {
    const lanes = group.lanes.map((lane) => {
      const result = resultByLane.get(`${group.id}:${lane.id}`) ?? input.missingLaneOutput(item, group, lane);
      return {
        id: lane.id,
        roleName: lane.roleName,
        status: result.status,
        output: result.output,
        outputPath: result.outputPath,
        blockedReason: lane.blockedReason ?? result.blockedReason ?? stringField(result.output, "blockedReason"),
        errorCode: lane.errorCode ?? result.errorCode
      };
    });
    return { id: group.id, mode: group.mode, status: fanoutGroupStatus(lanes.map((lane) => ({ status: lane.status }))), lanes };
  });
  const laneOutputs = groups.flatMap((group) => group.lanes.map((lane) => ({
    itemId: item.id,
    itemIndex: item.index,
    groupId: group.id,
    laneId: lane.id,
    roleName: lane.roleName,
    output: lane.output,
    outputPath: lane.outputPath,
    status: lane.status
  })));
  const blockedLaneOutputs = laneOutputs.filter((lane) => lane.status !== "completed");
  const partial = blockedLaneOutputs.length > 0 && input.allowPartial;
  const status = blockedLaneOutputs.length > 0 && !input.allowPartial ? "blocked" : "completed";
  const firstBlockedLane = blockedLaneOutputs[0];
  const firstBlockedOutput = objectRecord(firstBlockedLane?.output);
  return {
    status,
    summary: `Fanout item ${item.id} completed ${laneOutputs.length - blockedLaneOutputs.length}/${laneOutputs.length} lane(s).`,
    artifacts: [],
    nextFocus: "reduce",
    itemId: item.id,
    itemIndex: item.index,
    groups,
    laneOutputs,
    partial,
    blockedLanes: blockedLaneOutputs.map((lane) => ({ groupId: lane.groupId, laneId: lane.laneId, status: lane.status })),
    blockedReason: status === "blocked" ? stringField(firstBlockedOutput, "blockedReason") ?? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED : undefined,
    runtimeDiagnostics: status === "blocked" ? firstBlockedOutput?.runtimeDiagnostics : undefined
  };
}

export function buildFanoutStageOutput(input: {
  plan: Pick<FanoutCorePlan, "allowPartial" | "minCompletedRatio" | "maxBlockedItems">;
  itemOutputs: Record<string, unknown>[];
  skippedItems: Array<{ id: string; index: number; status: "skipped"; skippedReason?: string }>;
}): FanoutCoreAggregate {
  const laneOutputs = input.itemOutputs.flatMap((item) => Array.isArray(item.laneOutputs) ? item.laneOutputs as FanoutCoreLaneResult[] : []);
  const blockedItems = input.itemOutputs.filter((output) => output.status === "blocked" || output.partial === true);
  const completed = input.itemOutputs.filter((output) => output.status === "completed" && output.partial !== true).length;
  const nonCompletedItems = input.itemOutputs.filter((output) => output.status !== "completed" || output.partial === true);
  const ratio = input.itemOutputs.length === 0 ? 1 : completed / input.itemOutputs.length;
  const partialAllowed = input.plan.allowPartial
    && (input.plan.minCompletedRatio == null || ratio >= input.plan.minCompletedRatio)
    && (input.plan.maxBlockedItems == null || nonCompletedItems.length <= input.plan.maxBlockedItems);
  const status = nonCompletedItems.length > 0 && !partialAllowed ? "blocked" : "completed";
  return {
    status,
    summary: `Fanout completed with ${input.itemOutputs.length} active item output(s) and ${input.skippedItems.length} skipped item(s).`,
    items: input.itemOutputs,
    laneOutputs,
    blockedItems,
    skippedItems: input.skippedItems,
    artifacts: [],
    nextFocus: "reduce",
    blockedReason: status === "blocked" ? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED : undefined
  };
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
