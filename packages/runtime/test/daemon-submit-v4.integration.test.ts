import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requestDaemonControl as requestDaemonControlEffect,
  requestDaemonStatus as requestDaemonStatusEffect,
  requestDaemonSubmitAndObserve as requestDaemonSubmitAndObserveStream,
} from "../src/daemon/client.js";
import { startDaemonLoop } from "./support/daemon-loop.js";
import type {
  DaemonRunStreamFrame,
  RuntimeAuthorityIdentity,
} from "../src/daemon/protocol.js";
import {
  activeTaskWorkflow,
  waitUntil,
} from "./support/daemon-lease-fixture.js";
import {
  initializeRuntimeStoreForTest,
  prepareSyntheticWorkflow,
  runtimeRows,
  runtimeRunsRoot,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

function requestDaemonControl(...args: Parameters<typeof requestDaemonControlEffect>) {
  return Effect.runPromise(Effect.result(requestDaemonControlEffect(...args)));
}

function requestDaemonStatus(...args: Parameters<typeof requestDaemonStatusEffect>) {
  return Effect.runPromise(Effect.result(requestDaemonStatusEffect(...args)));
}

function requestDaemonSubmitAndObserve(...args: Parameters<typeof requestDaemonSubmitAndObserveStream>) {
  return Stream.toAsyncIterable(Stream.result(requestDaemonSubmitAndObserveStream(...args)));
}

describe("daemon v4 submit authority", () => {
  it("rejects every authority field mismatch before any run mutation", async () => {
    await withRuntimeWorkspace("daemon-v4-authority-mismatch", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 10,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const authority = await currentAuthority(workspace);
        const mismatches = [
          { ...authority, workspaceKey: alternateHex(authority.workspaceKey) },
          { ...authority, runtimeAbi: authority.runtimeAbi + 1 },
          { ...authority, layoutVersion: authority.layoutVersion + 1 },
          { ...authority, storageVersion: authority.storageVersion + 1 },
          { ...authority, authorityId: alternateHex(authority.authorityId) },
          { ...authority, leaseGeneration: authority.leaseGeneration + 1 },
        ];

        for (const [index, expectedAuthority] of mismatches.entries()) {
          const frames = await submit(workspace, {
            expectedAuthority: expectedAuthority as RuntimeAuthorityIdentity,
            requestId: `authority-mismatch-${index}`,
            prepared,
            input: { ready: true },
          });
          expect(frames).toEqual([{
            kind: "error",
            phase: "authority",
            outcome: "not-admitted",
            error: {
              code: "AUTHORITY_MISMATCH",
              message: "Runtime authority changed before run admission.",
            },
          }]);
        }

        expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([]);
        expect(runtimeRows(workspace, "SELECT run_id FROM run_events")).toEqual([]);
        expect(runtimeRows(workspace, "SELECT run_id FROM run_leases")).toEqual([]);
        expect(runtimeRows(workspace, "SELECT run_id FROM node_attempts")).toEqual([]);
        expect(await readdir(runtimeRunsRoot(workspace))).toEqual([]);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("replays one request into one run and rejects a conflicting fingerprint without writes", async () => {
    await withRuntimeWorkspace("daemon-v4-admission-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, activeTaskWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 10,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const authority = await currentAuthority(workspace);
        const requestId = "daemon-v4-admission-replay";
        const first = await submit(workspace, {
          expectedAuthority: authority,
          requestId,
          prepared,
          input: {},
        });
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ kind: "admitted", run: { id: expect.any(String) } });
        if (first[0]?.kind !== "admitted") throw new Error("Expected an admitted frame.");
        const runId = first[0].run.id;
        await waitUntil(() =>
          runtimeRows(
            workspace,
            "SELECT run_id FROM node_attempts WHERE run_id = ? AND status = 'started'",
            runId,
          ).length === 1);

        const replay = await submit(workspace, {
          expectedAuthority: authority,
          requestId,
          prepared,
          input: {},
        });
        expect(replay).toHaveLength(1);
        expect(replay[0]).toMatchObject({ kind: "admitted", run: { id: runId } });

        expect(await readdir(runtimeRunsRoot(workspace))).toEqual([runId]);
        expect(runtimeRows(
          workspace,
          "SELECT run_id FROM run_events WHERE type = 'run.admitted'",
        )).toEqual([{ run_id: runId }]);
        expect(runtimeRows(
          workspace,
          "SELECT run_id, released_at FROM run_leases WHERE run_id = ?",
          runId,
        )).toEqual([{ run_id: runId, released_at: null }]);
        expect(runtimeRows(
          workspace,
          "SELECT run_id FROM node_attempts WHERE run_id = ?",
          runId,
        )).toEqual([{ run_id: runId }]);

        const beforeConflict = await durableAdmissionFootprint(workspace, runId);
        const conflict = await submit(workspace, {
          expectedAuthority: authority,
          requestId,
          prepared,
          input: { markerPath: join(workspace, "different.marker") },
        });
        expect(conflict).toEqual([{
          kind: "error",
          phase: "admission",
          outcome: "not-admitted",
          error: {
            code: "CONTROL_CONFLICT",
            message: `Admission request '${requestId}' conflicts with a different prepared run.`,
          },
        }]);
        expect(await durableAdmissionFootprint(workspace, runId)).toEqual(beforeConflict);

        const paused = await requestDaemonControl(workspace, {
          requestId: "pause-before-admission-replay",
          type: "pause",
          runId,
        });
        expect(Result.isSuccess(paused) ? paused.success.run.status : undefined).toBe("paused");
        const beforePausedReplay = await durableAdmissionFootprint(workspace, runId);

        const pausedReplay = await submit(workspace, {
          expectedAuthority: authority,
          requestId,
          prepared,
          input: {},
        });
        expect(pausedReplay[0]).toMatchObject({
          kind: "admitted",
          run: { id: runId, status: "paused" },
        });
        expect(await durableAdmissionFootprint(workspace, runId)).toEqual(beforePausedReplay);
      } finally {
        await loop.shutdown();
      }
    });
  });
});

async function currentAuthority(cwd: string): Promise<RuntimeAuthorityIdentity> {
  const status = await requestDaemonStatus(cwd);
  if (Result.isFailure(status)) throw new Error(status.failure.message);
  return status.success.authority;
}

async function submit(
  cwd: string,
  input: {
    expectedAuthority: RuntimeAuthorityIdentity;
    requestId: string;
    prepared: Parameters<typeof requestDaemonSubmitAndObserve>[1]["prepared"];
    input: Parameters<typeof requestDaemonSubmitAndObserve>[1]["input"];
  },
): Promise<DaemonRunStreamFrame[]> {
  const frames: DaemonRunStreamFrame[] = [];
  for await (const frame of requestDaemonSubmitAndObserve(cwd, { ...input, until: "admitted" })) {
    if (Result.isFailure(frame)) throw new Error(frame.failure.message);
    frames.push(frame.success);
  }
  return frames;
}

async function durableAdmissionFootprint(workspace: string, runId: string): Promise<unknown> {
  return {
    runDirectories: await readdir(runtimeRunsRoot(workspace)),
    runs: runtimeRows(workspace, "SELECT id, status FROM runs ORDER BY id"),
    events: runtimeRows(
      workspace,
      "SELECT sequence, type, idempotency_key FROM run_events WHERE run_id = ? ORDER BY sequence",
      runId,
    ),
    leases: runtimeRows(
      workspace,
      "SELECT owner_id, owner_epoch, released_at FROM run_leases WHERE run_id = ?",
      runId,
    ),
    attempts: runtimeRows(
      workspace,
      "SELECT attempt_id, attempt_no, owner_epoch, status FROM node_attempts WHERE run_id = ? ORDER BY attempt_no",
      runId,
    ),
  };
}

function alternateHex(value: string): string {
  return `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
}
