import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDaemonLoop } from "../src/index.js";
import { prepareSyntheticWorkflow, runtimeRows } from "./support/runtime-fixtures.js";
import {
  activeTaskWorkflow,
  requestDaemonControl,
  requestDaemonShutdown,
  requestDaemonStatus,
  targetedParallelTaskWorkflow,
  waitForTerminalRun,
  waitUntil,
  withDaemonLeaseWorkspace,
} from "./support/daemon-lease-fixture.js";
import { submitRunThroughDaemon } from "./support/daemon-submit.js";

describe.concurrent("daemon lease active execution", () => {
  it("applies cancel to daemon-owned active execution without lease conflict", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const markerPath = join(dir, "active-cancel.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { markerPath },
        });
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "started");
        await expect(requestDaemonControl(dir, {
          requestId: "test-active-cancel",
          type: "cancel",
          runId: admitted.id,
        })).resolves.toMatchObject({
          run: { id: admitted.id, status: "canceled" },
        });
        await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
          status: "canceled",
          run: { id: admitted.id, status: "canceled" },
        });
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("aborts only the targeted active Task while a parallel sibling completes", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const leftMarker = join(dir, "targeted-parallel-left.marker");
      const rightMarker = join(dir, "targeted-parallel-right.marker");
      const rightRelease = join(dir, "targeted-parallel-right.release");
      const prepared = await prepareSyntheticWorkflow(dir, targetedParallelTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { leftMarker, rightMarker, rightRelease },
        });
        await waitUntil(async () =>
          await readFile(leftMarker, "utf8").catch(() => undefined) === "started"
          && await readFile(rightMarker, "utf8").catch(() => undefined) === "started");
        const attempts = runtimeRows(
          dir,
          "SELECT attempt_id, node_key, node_id FROM node_attempts WHERE run_id = ? AND status = 'started' ORDER BY node_id",
          admitted.id,
        ) as Array<{ attempt_id: string; node_key: string; node_id: string }>;
        expect(attempts.map(attempt => attempt.node_id))
          .toEqual(["left_task", "right_task"]);
        const left = attempts.find(attempt => attempt.node_id === "left_task")!;

        await expect(requestDaemonControl(dir, {
          requestId: "test-targeted-active-cancel",
          type: "cancel",
          runId: admitted.id,
          target: left.node_key,
        })).resolves.toMatchObject({
          type: "cancel",
          state: "applied",
          target: left.node_key,
          run: { id: admitted.id, status: "running" },
        });
        await writeFile(rightRelease, "release");
        await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
          status: "completed",
          run: { status: "completed", output: { winner: "right", value: "right" } },
        });
        await waitUntil(async () =>
          await readFile(leftMarker, "utf8").catch(() => undefined) === "aborted");
        await expect(readFile(rightMarker, "utf8")).resolves.toBe("completed");
        expect(runtimeRows(
          dir,
          "SELECT node_id, status, cancel_reason FROM node_attempts WHERE run_id = ? ORDER BY node_id",
          admitted.id,
        )).toEqual([
          { node_id: "left_task", status: "cancelled", cancel_reason: "operator_cancelled" },
          { node_id: "right_task", status: "completed", cancel_reason: null },
        ]);
        expect(runtimeRows(
          dir,
          "SELECT branch_id, status, terminal_reason FROM group_members WHERE run_id = ? ORDER BY branch_id",
          admitted.id,
        )).toEqual([
          { branch_id: "left", status: "cancelled", terminal_reason: "operator_cancelled" },
          { branch_id: "right", status: "completed", terminal_reason: null },
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 10_000);

  it("does not expose inactive scheduler ownership details through daemon control", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const markerPath = join(dir, "inactive-owner-control.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { markerPath },
        });
        await waitUntil(() => runtimeRows(
          dir,
          "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'",
          admitted.id,
        ).length > 0);
        const row = runtimeRows(
          dir,
          "SELECT owner_id, owner_epoch, lease_expires_at FROM run_leases WHERE run_id = ? AND released_at IS NULL",
          admitted.id,
        )[0] as { owner_id: string; owner_epoch: number; lease_expires_at: string };
        expect(store.scheduler.releaseRun({
          runId: admitted.id,
          ownerId: row.owner_id,
          ownerEpoch: row.owner_epoch,
          leaseExpiresAt: row.lease_expires_at,
        })).toBe(true);

        await expect(requestDaemonControl(dir, {
          requestId: "test-inactive-owner",
          type: "cancel",
          runId: admitted.id,
        })).rejects.toMatchObject({ code: "RUN_NOT_CONTROLLABLE" });
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("applies immediate control after admission without falling back to a second owner", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const markerPath = join(dir, "immediate-cancel.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { markerPath },
        });
        await expect(requestDaemonControl(dir, {
          requestId: "test-immediate-cancel",
          type: "cancel",
          runId: admitted.id,
        })).resolves.toMatchObject({
          run: { id: admitted.id, status: "canceled" },
        });
        await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
          status: "canceled",
          run: { id: admitted.id, status: "canceled" },
        });
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("rejects shutdown while a run execution session is active", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const markerPath = join(dir, "shutdown-active.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { markerPath },
        });
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "started");
        await expect(requestDaemonShutdown(dir))
          .rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
        await expect(requestDaemonControl(dir, {
          requestId: "test-shutdown-active-cancel",
          type: "cancel",
          runId: admitted.id,
        })).resolves.toMatchObject({
          run: { id: admitted.id, status: "canceled" },
        });
        await expect(waitForTerminalRun(dir, admitted.id))
          .resolves.toMatchObject({ status: "canceled" });
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("fences and stops active executors during host teardown without mutating the run", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const markerPath = join(dir, "host-teardown.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { markerPath },
        });
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "started");
        await loop.shutdown();
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
        expect(runtimeRows(dir, "SELECT status FROM runs WHERE id = ?", admitted.id))
          .toEqual([{ status: "running" }]);
        expect(runtimeRows(
          dir,
          "SELECT status FROM node_attempts WHERE run_id = ?",
          admitted.id,
        )).toEqual([{ status: "started" }]);
        expect(runtimeRows(
          dir,
          "SELECT released_at IS NOT NULL AS released FROM run_leases WHERE run_id = ?",
          admitted.id,
        )).toEqual([{ released: 1 }]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("does not idle-stop while a run execution session is active", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const markerPath = join(dir, "idle-active.marker");
      const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
      const admission = await store.admitRun({
        prepared,
        cwd: dir,
        input: { markerPath },
      });
      if (admission.isErr()) throw new Error(admission.error.message);
      const admitted = admission.value;
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        idleStopMs: 0,
        packageVersion: "0.0.0-test",
      });
      try {
        await waitUntil(async () =>
          await readFile(markerPath, "utf8").catch(() => undefined) === "started");
        let heartbeatAt = store.getRuntimeDiagnostics().authority?.heartbeatAt;
        expect(heartbeatAt).toBeDefined();
        for (let count = 0; count < 2; count += 1) {
          const previous = heartbeatAt;
          await waitUntil(() => {
            const current = store.getRuntimeDiagnostics().authority?.heartbeatAt;
            if (current === undefined || current === previous) return false;
            heartbeatAt = current;
            return true;
          });
        }
        await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
        await expect(requestDaemonControl(dir, {
          requestId: "test-idle-active-cancel",
          type: "cancel",
          runId: admitted.id,
        })).resolves.toMatchObject({
          run: { id: admitted.id, status: "canceled" },
        });
        await expect(waitForTerminalRun(dir, admitted.id))
          .resolves.toMatchObject({ status: "canceled" });
      } finally {
        await loop.shutdown();
      }
    });
  });
});
