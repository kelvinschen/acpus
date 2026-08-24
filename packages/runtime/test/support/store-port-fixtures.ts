import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RuntimeStoreAdapter } from "../../src/store/store.js";
import type { RunOwnerClaim } from "../../src/scheduler/store-port.js";
import { runtimeDatabasePath } from "./runtime-harness.js";
import { throwingSchedulerStore } from "./scheduler-store.js";

export function readyNode(store: RuntimeStoreAdapter, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.ready", payload: { runId, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
    ],
  });
}

export function awaitingSignal(store: RuntimeStoreAdapter, runId: string, claim: RunOwnerClaim, idempotencyKey: string, signal: { deadlineAt?: string; timeoutMessage?: string } = {}): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.ready", payload: { runId, nodeKey: "approve~1", nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: "approve~1", nodeId: "approve", ...signal } },
    ],
  });
}

export function dbScalar(workspace: string, sql: string, ...params: SQLInputValue[]): unknown {
  const row = dbRow(workspace, sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}

export function dbRow(workspace: string, sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

export function dbRun(workspace: string, sql: string, ...params: SQLInputValue[]): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
