import { describe, expect, it } from "vitest";
import { resolveSignalPayload, type RunControlIntent } from "../src/scheduler/control.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";

describe("scheduler signal target resolution", () => {
  it("binds a replayed command to its consumed dynamic wait before considering a new alias match", () => {
    const runId = "run_signal_replay";
    const consumedKey = "approve~consumed";
    const awaitingKey = "approve~awaiting";
    const projection = applySchedulerEvents(createSchedulerProjection(runId), [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
      { type: "instance.ready", payload: { runId, nodeKey: consumedKey, nodeId: "approve", parentFrameKey: "root", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 0 }, { kind: "node", nodeId: "approve" }] } },
      { type: "instance.awaiting", payload: { nodeKey: consumedKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: consumedKey, nodeId: "approve" } },
      { type: "signal.consumed", payload: { nodeKey: consumedKey, payload: { ok: true }, commandIdempotencyKey: "command-1" } },
      { type: "instance.completed", payload: { nodeKey: consumedKey, output: { ok: true } } },
      { type: "instance.ready", payload: { runId, nodeKey: awaitingKey, nodeId: "approve", parentFrameKey: "root", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "approve" }] } },
      { type: "instance.awaiting", payload: { nodeKey: awaitingKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: awaitingKey, nodeId: "approve" } },
    ]);
    const snapshot: SchedulerSnapshot = { runId, version: 9, projection };
    const intent: Extract<RunControlIntent, { type: "signal" }> = {
      requestId: "request-1",
      commandIdempotencyKey: "command-1",
      runId,
      type: "signal",
      node: "approve",
      payload: { ok: true },
    };

    expect(resolveSignalPayload(intent, snapshot)).toEqual(expect.objectContaining({
      value: { nodeKey: consumedKey, nodeId: "approve", payload: { ok: true } },
    }));
    expect(snapshot.projection.signalWaits[awaitingKey]).toMatchObject({ status: "awaiting" });
  });
});
