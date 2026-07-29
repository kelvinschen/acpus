import { describe, expect, it } from "vitest";
import type {
  RunInspectionRaw,
  WatchInspectionEmission,
  RunInspectionSnapshot,
  RunInspectionTimelineDocument,
} from "@acpus/runtime";
import {
  presentInspectionEmissionJson,
  presentInspectionJson,
  type PresentedInspectionJson,
} from "../src/run-inspection-json.js";

describe("inspection JSON presentation", () => {
  it("keeps an overview observable through refs without Runtime occurrence keys", () => {
    const presented = presentInspectionJson(snapshot());
    const item = items(presented)[0]!;
    const treeEntry = (presented["tree"] as PresentedInspectionJson[])[0]!;
    const actions = treeEntry["actions"] as PresentedInspectionJson[];
    const run = presented["run"] as PresentedInspectionJson;

    expect(item).toMatchObject({
      ref: "@1a2b3c4d5e6f",
      path: ["batch[0]", "review"],
      status: "awaiting",
      agent: { key: "reviewer" },
      signal: { target: "@1a2b3c4d5e6f", schemaSummary: "{ answer: string }" },
    });
    expect(item).not.toHaveProperty("key");
    expect(item).not.toHaveProperty("parentKey");
    expect(item).not.toHaveProperty("nodeKey");
    expect(item).not.toHaveProperty("frameKey");
    expect(item).not.toHaveProperty("attemptId");
    expect(presented).not.toHaveProperty("items");
    expect(presented).not.toHaveProperty("availableActions");
    expect(presented["tree"]).toEqual([expect.objectContaining({ type: "item" })]);
    expect(actions).toEqual([{ kind: "signal", target: "@1a2b3c4d5e6f", schemaSummary: "{ answer: string }" }]);
    expect(run["execution"]).toEqual({ state: "active", lastStatus: "running" });
    expect(JSON.stringify(run)).not.toContain("daemonHeartbeatAt");
    expect(JSON.stringify(run)).not.toContain("ownerId");
    expect(JSON.stringify(run)).not.toContain("leaseExpiresAt");
    expect(run["fork"]).toEqual({ sourceRunId: "run_parent", unsafeReuse: true });
    expect(presented["hooks"]).toEqual([{
      status: "completed",
      handlerId: "notify",
      event: "run.completed",
      eventSequence: 9,
      durationMs: 12,
      exitCode: 0,
    }]);
    expect(presented["output"]).toEqual({ key: "workflow-owned", attemptId: "workflow-owned" });
  });

  it("uses the short target ref while removing attempt identifiers from Timeline data", () => {
    const presented = presentInspectionJson(timeline());
    const subject = presented["subject"] as PresentedInspectionJson;
    const current = presented["current"] as PresentedInspectionJson;
    const recent = presented["recent"] as PresentedInspectionJson;
    const entry = (recent["entries"] as PresentedInspectionJson[])[0]!;

    expect(subject).toMatchObject({ id: "@1a2b3c4d5e6f#2", ref: "@1a2b3c4d5e6f#2", attemptNo: 2 });
    expect(subject).not.toHaveProperty("nodeKey");
    expect(subject).not.toHaveProperty("attemptId");
    expect(current).toMatchObject({ kind: "agent", attemptNo: 2, turn: 4, phase: "tool" });
    expect(current).not.toHaveProperty("attemptId");
    expect(entry).toMatchObject({ kind: "activity", attemptNo: 2, channel: "tool" });
    expect(entry).not.toHaveProperty("id");
    expect(entry).not.toHaveProperty("attemptId");
  });

  it("presents folded topology without an unfolded items dossier or representative selector", () => {
    const presented = presentInspectionJson(foldedSnapshot());
    const tree = presented["tree"] as PresentedInspectionJson[];
    const root = tree[0]!;
    const fold = (root["children"] as PresentedInspectionJson[])[0]!;
    const nested = (fold["children"] as PresentedInspectionJson[])[0]!;
    const foldItem = fold["item"] as PresentedInspectionJson;
    const nestedItem = nested["item"] as PresentedInspectionJson;

    expect(presented).not.toHaveProperty("items");
    expect(fold).toMatchObject({
      type: "fold",
      scope: "fanout_item",
      range: { start: 0, end: 3 },
      count: 4,
      owner: { ref: "@batch" },
    });
    expect(foldItem).not.toHaveProperty("ref");
    expect(nestedItem).not.toHaveProperty("ref");
    expect(nested).not.toHaveProperty("actions");
    expect(JSON.stringify(presented)).not.toContain("raw-");
  });

  it("keeps planner-approved singleton controls on their safe tree item selectors", () => {
    const source = snapshot();
    source.availableActions = [
      { kind: "retry", itemKey: source.items[0]!.key, target: "raw-retry" },
      { kind: "cancel", itemKey: source.items[0]!.key, target: "raw-cancel" },
      { kind: "steer", itemKey: source.items[0]!.key, target: "raw-steer" },
    ];

    const presented = presentInspectionJson(source);
    const treeEntry = (presented["tree"] as PresentedInspectionJson[])[0]!;

    expect(presented).not.toHaveProperty("availableActions");
    expect(treeEntry["controls"]).toEqual([
      { kind: "retry", target: "@1a2b3c4d5e6f" },
      { kind: "cancel", target: "@1a2b3c4d5e6f" },
      { kind: "steer", target: "@1a2b3c4d5e6f#2" },
    ]);
    expect(JSON.stringify(presented)).not.toContain("raw-");
  });

  it("keeps normal JSON nonlinear for 10,000 homogeneous contexts", () => {
    const rendered = JSON.stringify(presentInspectionJson(foldedSnapshot(10_000)));

    expect(Buffer.byteLength(rendered)).toBeLessThan(4_096);
  });

  it("does not expose a nested fold's representative owner selector", () => {
    const presented = presentInspectionJson(nestedFoldedSnapshot());
    const root = (presented["tree"] as PresentedInspectionJson[])[0]!;
    const outerFold = (root["children"] as PresentedInspectionJson[])[0]!;
    const innerOwner = (outerFold["children"] as PresentedInspectionJson[])[0]!;
    const innerFold = (innerOwner["children"] as PresentedInspectionJson[])[0]!;

    expect(outerFold).toMatchObject({ type: "fold", owner: { ref: "@outer" } });
    expect(innerFold).toMatchObject({ type: "fold" });
    expect(innerFold).not.toHaveProperty("owner");
    expect(JSON.stringify(presented)).not.toContain("@inner-0");
  });

  it("sanitizes follow views and Timeline entries without filtering explicit raw", () => {
    const source = snapshot();
    const emission = {
      schemaVersion: 2,
      kind: "timeline-entry",
      entry: {
        id: "activity:1",
        kind: "activity",
        at: "2026-07-29T00:00:00.000Z",
        attemptId: "attempt_internal",
        attemptNo: 2,
        channel: "tool",
        summary: { text: "read status", originalBytes: 11, truncated: false },
      },
    } satisfies WatchInspectionEmission;

    const presented = presentInspectionEmissionJson(emission);

    expect(presented).toMatchObject({ kind: "timeline-entry", entry: { kind: "activity", attemptNo: 2 } });
    expect((presented["entry"] as PresentedInspectionJson)).not.toHaveProperty("id");
    expect((presented["entry"] as PresentedInspectionJson)).not.toHaveProperty("attemptId");

    const view = presentInspectionEmissionJson({ schemaVersion: 2, kind: "view", document: source });
    expect(view["document"]).not.toHaveProperty("items");
    expect(JSON.stringify(view)).not.toContain("review~internal");

    const raw = { schemaVersion: 2, kind: "raw", key: "diagnostic-only" } as unknown as RunInspectionRaw;
    expect(presentInspectionJson(raw)).toBe(raw);
  });
});

function items(document: PresentedInspectionJson): PresentedInspectionJson[] {
  const tree = document["tree"] as PresentedInspectionJson[];
  return tree.map(entry => entry["item"] as PresentedInspectionJson);
}

function snapshot(): RunInspectionSnapshot {
  return {
    schemaVersion: 2,
    kind: "snapshot",
    run: {
      id: "run_1",
      name: "review",
      status: "running",
      workflowEntry: "review.workflow.ts",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      execution: {
        state: "active",
        lastStatus: "running",
        daemonHeartbeatAt: "2026-07-29T00:00:00.000Z",
        ownerId: "daemon:internal",
        leaseExpiresAt: "2026-07-29T00:01:00.000Z",
      },
      fork: { sourceRunId: "run_parent", target: "review~internal", unsafeReuse: true },
    },
    counts: { total: 1, awaiting: 1 },
    items: [{
      key: "instance:review~internal",
      parentKey: "frame:batch~internal",
      role: "instance",
      path: ["batch[0]", "review"],
      label: "batch[0] › review",
      kind: "agent",
      status: "awaiting",
      nodeId: "review",
      ref: "@1a2b3c4d5e6f",
      nodeKey: "review~internal",
      frameKey: "frame:batch~internal",
      attemptId: "attempt_internal",
      attemptNo: 2,
      agent: { key: "reviewer", turn: 4 },
      signal: {
        target: "signal~internal",
        schemaSummary: "{ answer: string }",
      },
    }],
    availableActions: [{ kind: "signal", itemKey: "instance:review~internal", target: "signal~internal", schemaSummary: "{ answer: string }" }],
    output: { key: "workflow-owned", attemptId: "workflow-owned" },
    hooks: [{
      id: 4,
      runId: "run_1",
      eventSequence: 9,
      triggerOrder: 2,
      event: "run.completed",
      source: "project",
      sourcePath: "/workspace/acpus.hooks.ts",
      handlerId: "notify",
      definitionHash: "sha256:internal",
      nodeKey: "review~internal",
      status: "completed",
      exitCode: 0,
      stdout: "long private payload",
      stderr: "private stderr",
      durationMs: 12,
      error: "private error",
      triggeredAt: "2026-07-29T00:00:00.000Z",
    }],
  };
}

function timeline(): RunInspectionTimelineDocument {
  const subject = {
    targetKind: "attempt" as const,
    id: "attempt_internal",
    ref: "@1a2b3c4d5e6f#2",
    label: "review",
    kind: "agent",
    nodeId: "review",
    nodeKey: "review~internal",
    attemptId: "attempt_internal",
    attemptNo: 2,
  } as RunInspectionTimelineDocument["subject"];
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-29T00:00:00.000Z" },
    subject,
    state: { status: "running" },
    current: {
      kind: "agent",
      attemptId: "attempt_internal",
      attemptNo: 2,
      turn: 4,
      turnKind: "task",
      phase: "tool",
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
    recent: {
      entries: [{
        id: "activity:1",
        kind: "activity",
        at: "2026-07-29T00:00:00.000Z",
        attemptId: "attempt_internal",
        attemptNo: 2,
        channel: "tool",
        summary: { text: "read status", originalBytes: 11, truncated: false },
      }],
      page: 1,
      limit: 12,
      returned: 1,
      omittedBefore: 0,
      hasOlder: false,
    },
  };
}

function foldedSnapshot(count = 4): RunInspectionSnapshot {
  const document = snapshot();
  document.counts = { total: count, completed: count };
  document.items = [{
    key: "raw-batch",
    role: "instance",
    path: ["batch"],
    label: "batch",
    kind: "fanout",
    status: "completed",
    nodeId: "batch",
    nodeKey: "raw-batch",
    ref: "@batch",
  }];
  for (let index = 0; index < count; index += 1) {
    const contextKey = `raw-context-${index}`;
    document.items.push({
      key: contextKey,
      parentKey: "raw-batch",
      role: "context",
      path: [`batch[${index}]`],
      label: `item[${index}]`,
      kind: "fanout_item",
      status: "completed",
      nodeId: "batch",
      nodeKey: contextKey,
      frameKey: `raw-frame-${index}`,
      ref: `@context-${index}`,
      scope: { kind: "fanout_item", itemIndex: index, empty: false },
    });
    document.items.push({
      key: `raw-child-${index}`,
      parentKey: contextKey,
      role: "instance",
      path: [`batch[${index}]`, "review"],
      label: "review",
      kind: "agent",
      status: "completed",
      nodeId: "review",
      nodeKey: `raw-child-${index}`,
      ref: `@child-${index}`,
      agent: { key: "reviewer", turn: 1 },
    });
  }
  document.availableActions = [];
  return document;
}

function nestedFoldedSnapshot(): RunInspectionSnapshot {
  const document = snapshot();
  document.counts = { total: 16, completed: 16 };
  document.items = [{
    key: "raw-outer",
    role: "instance",
    path: ["outer"],
    label: "outer",
    kind: "fanout",
    status: "completed",
    nodeId: "outer",
    nodeKey: "raw-outer",
    ref: "@outer",
  }];
  for (let outer = 0; outer < 4; outer += 1) {
    const outerContext = `raw-outer-context-${outer}`;
    const innerOwner = `raw-inner-owner-${outer}`;
    document.items.push({
      key: outerContext,
      parentKey: "raw-outer",
      role: "context",
      path: [`outer[${outer}]`],
      label: `item[${outer}]`,
      kind: "fanout_item",
      status: "completed",
      nodeId: "outer",
      frameKey: outerContext,
      ref: `@outer-context-${outer}`,
      scope: { kind: "fanout_item", itemIndex: outer, empty: false },
    });
    document.items.push({
      key: innerOwner,
      parentKey: outerContext,
      role: "instance",
      path: [`outer[${outer}]`, "inner"],
      label: "inner",
      kind: "fanout",
      status: "completed",
      nodeId: "inner",
      nodeKey: innerOwner,
      ref: `@inner-${outer}`,
    });
    for (let inner = 0; inner < 4; inner += 1) {
      const innerContext = `raw-inner-context-${outer}-${inner}`;
      document.items.push({
        key: innerContext,
        parentKey: innerOwner,
        role: "context",
        path: [`outer[${outer}]`, `inner[${inner}]`],
        label: `item[${inner}]`,
        kind: "fanout_item",
        status: "completed",
        nodeId: "inner",
        frameKey: innerContext,
        ref: `@inner-context-${outer}-${inner}`,
        scope: { kind: "fanout_item", itemIndex: inner, empty: false },
      });
      document.items.push({
        key: `raw-inner-child-${outer}-${inner}`,
        parentKey: innerContext,
        role: "instance",
        path: [`outer[${outer}]`, `inner[${inner}]`, "review"],
        label: "review",
        kind: "task",
        status: "completed",
        nodeId: "review",
        nodeKey: `raw-inner-child-${outer}-${inner}`,
        ref: `@inner-child-${outer}-${inner}`,
      });
    }
  }
  document.availableActions = [];
  return document;
}
