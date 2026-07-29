import { describe, expect, it } from "vitest";
import type { RunInspectionItem, RunInspectionOverviewAction, RunInspectionStatus } from "@acpus/runtime";
import { buildRunInspectionTree, inspectionTreeAttention } from "../src/run-inspection-tree.js";

describe("run inspection tree", () => {
  it("keeps one through three contexts expanded and folds four equivalent siblings", () => {
    for (const count of [1, 2, 3]) {
      expect(children(buildRunInspectionTree(fanout(count)))).toHaveLength(count);
      expect(children(buildRunInspectionTree(fanout(count))).every(entry => entry.type === "item")).toBe(true);
    }

    const folded = children(buildRunInspectionTree(fanout(4)));

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      type: "fold",
      scope: "fanout_item",
      range: { start: 0, end: 3 },
      count: 4,
    });
    if (folded[0]?.type !== "fold") throw new Error("expected fold");
    expect(folded[0].representative.item.ref).toBe("@context-0");
    expect(folded[0].owner.ref).toBe("@batch");
  });

  it("compares visible descendants while ignoring occurrence identity and timestamps", () => {
    const same = buildRunInspectionTree(fanout(4));
    expect(children(same)[0]?.type).toBe("fold");

    const timestamped = fanout(4, {
      status: "awaiting",
      signal: { target: "raw:signal", schemaSummary: "{ answer: string }" },
    });
    for (const [index, item] of timestamped.entries()) {
      if (item.agent) {
        item.agent = {
          ...item.agent,
          lastObservedAt: `2026-07-29T00:00:0${index}.000Z`,
        } as typeof item.agent;
      }
      if (item.signal) {
        item.signal = { ...item.signal, deadlineAt: `2026-07-29T00:01:0${index}.000Z` };
      }
    }
    expect(children(buildRunInspectionTree(timestamped))[0]?.type).toBe("fold");

    const variants: Array<(items: RunInspectionItem[]) => void> = [
      items => { items[2] = { ...items[2]!, attemptNo: 2 }; },
      items => { items[2] = { ...items[2]!, agent: { key: "reviewer", turn: 1, activeTool: { command: "Read changed.md", status: "running" } } }; },
      items => { items[2] = { ...items[2]!, signal: { target: "raw:other", schemaSummary: "{ answer: number }" } }; },
      items => { items[2] = { ...items[2]!, status: "failed", failure: { origin: "task", code: "different", message: "different failure" } }; },
    ];
    for (const vary of variants) {
      const items = fanout(4);
      vary(items);
      expect(children(buildRunInspectionTree(items))).toHaveLength(4);
    }
  });

  it("does not fold non-contiguous item indexes or all-mode topology", () => {
    const gaps = fanout(4, { indexes: [0, 1, 3, 4] });
    expect(children(buildRunInspectionTree(gaps))).toHaveLength(4);
    expect(children(buildRunInspectionTree(fanout(4), { all: true }))).toHaveLength(4);
  });

  it("includes item-scoped action kinds in equality without exposing raw action targets", () => {
    const items = fanout(4);
    const actions: RunInspectionOverviewAction[] = [
      { kind: "signal", itemKey: "child-0", target: "raw:0" },
      { kind: "signal", itemKey: "child-1", target: "raw:1" },
      { kind: "signal", itemKey: "child-2", target: "raw:2" },
      { kind: "retry", itemKey: "child-3", target: "raw:3" },
    ];

    expect(children(buildRunInspectionTree(items, { actions }))).toHaveLength(4);
  });

  it("reuses folded groups for attention without selecting a representative occurrence", () => {
    const items = fanout(4, {
      status: "awaiting",
      signal: { target: "raw:signal", promptPreview: "approve", schemaSummary: "{ approved: boolean }" },
    });
    const tree = buildRunInspectionTree(items);
    const attention = inspectionTreeAttention(tree);

    expect(attention).toHaveLength(2);
    expect(attention.every(entry => entry.fold?.count === 4)).toBe(true);
    expect(attention.map(entry => entry.item.item.label)).toEqual(["item[0]", "review"]);
  });

  it("stays compact for 10,000 homogeneous contexts", () => {
    const tree = buildRunInspectionTree(fanout(10_000));
    const entries = children(tree);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "fold", count: 10_000, range: { start: 0, end: 9_999 } });
    expect(Buffer.byteLength(JSON.stringify(tree.roots))).toBeLessThan(4_096);
  });
});

function children(tree: ReturnType<typeof buildRunInspectionTree>) {
  const root = tree.roots[0];
  if (!root || root.type !== "item") throw new Error("expected fanout root");
  return root.children;
}

function fanout(
  count: number,
  options: {
    indexes?: readonly number[];
    status?: RunInspectionStatus;
    signal?: NonNullable<RunInspectionItem["signal"]>;
  } = {},
): RunInspectionItem[] {
  const indexes = options.indexes ?? Array.from({ length: count }, (_, index) => index);
  const status = options.status ?? "completed";
  const items: RunInspectionItem[] = [{
    key: "batch-internal",
    role: "instance",
    path: ["batch"],
    label: "batch",
    kind: "fanout",
    status: "completed",
    nodeId: "batch",
    nodeKey: "batch-internal",
    ref: "@batch",
  }];
  for (const index of indexes) {
    const contextKey = `context-${index}`;
    items.push({
      key: contextKey,
      parentKey: "batch-internal",
      role: "context",
      path: [`batch[${index}]`],
      label: `item[${index}]`,
      kind: "fanout_item",
      status,
      nodeId: "batch",
      nodeKey: `context-raw-${index}`,
      frameKey: `frame-raw-${index}`,
      attemptId: `attempt-raw-${index}`,
      attemptNo: 1,
      createdAt: `2026-07-29T00:00:0${index % 10}.000Z`,
      updatedAt: `2026-07-29T00:01:0${index % 10}.000Z`,
      ref: `@context-${index}`,
      scope: { kind: "fanout_item", itemIndex: index, empty: false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    items.push({
      key: `child-${index}`,
      parentKey: contextKey,
      role: "instance",
      path: [`batch[${index}]`, "review"],
      label: "review",
      kind: "agent",
      status,
      nodeId: "review",
      nodeKey: `review-raw-${index}`,
      attemptId: `attempt-raw-${index}`,
      attemptNo: 1,
      createdAt: `2026-07-29T00:00:0${index % 10}.000Z`,
      updatedAt: `2026-07-29T00:01:0${index % 10}.000Z`,
      ref: `@child-${index}`,
      agent: { key: "reviewer", turn: 1, activeTool: { command: "Read report.md", status: "running" } },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  return items;
}
