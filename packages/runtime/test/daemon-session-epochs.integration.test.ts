import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import type { Result } from "neverthrow";
import {
  getRun,
  requestDaemonAdmitRun as requestDaemonAdmitRunResult,
  requestDaemonControl as requestDaemonControlResult,
  startDaemonLoop,
  type DaemonClientFailure,
} from "../src/index.js";
import { initializeRuntimeStoreForTest, prepareSyntheticWorkflow, runtimeRows, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

async function requestDaemonAdmitRun(...args: Parameters<typeof requestDaemonAdmitRunResult>) {
  return unwrapDaemon(await requestDaemonAdmitRunResult(...args));
}

async function requestDaemonControl(...args: Parameters<typeof requestDaemonControlResult>) {
  return unwrapDaemon(await requestDaemonControlResult(...args));
}

function unwrapDaemon<T>(result: Result<T, DaemonClientFailure>): T {
  if (result.isOk()) return result.value;
  throw Object.assign(new Error(result.error.message), result.error.type === "rejected" ? { code: result.error.code } : {});
}

describe("daemon execution owner epochs", () => {
  it.concurrent("releases a paused owner before resume starts a new attempt epoch", async () => {
    await withRuntimeWorkspace("daemon-pause-resume-owner-epoch", async workspace => {
      const markerPath = join(workspace, "pause-resume.marker");
      const releasePath = join(workspace, "pause-resume.release");
      const prepared = await prepareSyntheticWorkflow(workspace, pausableTaskWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, { heartbeatMs: 10, packageVersion: "0.0.0-test" });
      try {
        const admitted = await requestDaemonAdmitRun(workspace, { prepared, input: { markerPath, releasePath } });
        await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "started");
        const first = runtimeRows(workspace, "SELECT attempt_no, owner_epoch FROM node_attempts WHERE run_id = ? ORDER BY attempt_no", admitted.id)[0] as { attempt_no: number; owner_epoch: number };

        await expect(requestDaemonControl(workspace, { requestId: "pause-active", type: "pause", runId: admitted.id })).resolves.toMatchObject({ run: { status: "paused" } });
        await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
        expect(runtimeRows(workspace, "SELECT released_at FROM run_leases WHERE run_id = ?", admitted.id)[0]).toMatchObject({ released_at: expect.any(String) });

        await writeFile(releasePath, "release");
        await expect(requestDaemonControl(workspace, { requestId: "resume-active", type: "resume", runId: admitted.id })).resolves.toMatchObject({ type: "resume", state: "applied" });
        await expect(waitForTerminalRun(workspace, admitted.id)).resolves.toMatchObject({ status: "completed", run: { output: { ok: true } } });
        const attempts = runtimeRows(workspace, "SELECT attempt_no, owner_epoch, status FROM node_attempts WHERE run_id = ? ORDER BY attempt_no", admitted.id) as Array<{ attempt_no: number; owner_epoch: number; status: string }>;
        expect(attempts).toEqual([
          { attempt_no: 1, owner_epoch: first.owner_epoch, status: "cancelled" },
          { attempt_no: 2, owner_epoch: expect.any(Number), status: "completed" },
        ]);
        expect(attempts[1]!.owner_epoch).toBeGreaterThan(first.owner_epoch);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it.concurrent("starts failed-run retry work under a new owner epoch", async () => {
    await withRuntimeWorkspace("daemon-retry-owner-epoch", async workspace => {
      const firstFailurePath = join(workspace, "retry-first-failure.marker");
      const prepared = await prepareSyntheticWorkflow(workspace, failOnceRetryWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, { heartbeatMs: 10, packageVersion: "0.0.0-test" });
      try {
        const admitted = await requestDaemonAdmitRun(workspace, { prepared, input: { firstFailurePath } });
        await expect(waitForTerminalRun(workspace, admitted.id)).resolves.toMatchObject({ status: "failed" });
        const first = runtimeRows(workspace, "SELECT owner_epoch FROM node_attempts WHERE run_id = ? AND attempt_no = 1", admitted.id)[0] as { owner_epoch: number };

        await expect(requestDaemonControl(workspace, { requestId: "retry-failed", type: "retry", runId: admitted.id })).resolves.toMatchObject({ type: "retry", state: "applied" });
        await waitUntil(() => {
          const attempt = runtimeRows(workspace, "SELECT owner_epoch FROM node_attempts WHERE run_id = ? ORDER BY owner_epoch DESC, attempt_no DESC LIMIT 1", admitted.id)[0] as { owner_epoch?: number } | undefined;
          return attempt?.owner_epoch !== undefined && attempt.owner_epoch > first.owner_epoch;
        });
        await expect(waitForTerminalRun(workspace, admitted.id)).resolves.toMatchObject({ status: "completed", run: { output: { ok: true } } });
        const latest = runtimeRows(workspace, "SELECT attempt_no, owner_epoch, status FROM node_attempts WHERE run_id = ? ORDER BY owner_epoch DESC, attempt_no DESC LIMIT 1", admitted.id)[0] as { attempt_no: number; owner_epoch: number; status: string };
        expect(latest).toMatchObject({ attempt_no: expect.any(Number), owner_epoch: expect.any(Number), status: "completed" });
        expect(latest.owner_epoch).toBeGreaterThan(first.owner_epoch);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);
});

function pausableTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-pause-resume-owner-epoch",
    inputSchema: z.object({ markerPath: z.string(), releasePath: z.string() }),
  }).build(({ input, step }) => {
    const task = step("work").task({
      input: { markerPath: input.markerPath, releasePath: input.releasePath },
      exec: async ({ input, abortSignal }) => await new Promise<{ ok: boolean }>(resolve => {
        const fs = process.getBuiltinModule("node:fs");
        const poll = setInterval(() => {
          if (!fs.existsSync(input.releasePath)) return;
          clearInterval(poll);
          fs.writeFileSync(input.markerPath, "completed");
          resolve({ ok: true });
        }, 5);
        abortSignal.addEventListener("abort", () => {
          clearInterval(poll);
          fs.writeFileSync(input.markerPath, "aborted");
          resolve({ ok: false });
        }, { once: true });
        fs.writeFileSync(input.markerPath, "started");
      }),
    });
    return { ok: task.output.ok };
  });
}

function failOnceRetryWorkflow() {
  return defineWorkflow({
    name: "daemon-retry-owner-epoch",
    inputSchema: z.object({ firstFailurePath: z.string() }),
  }).build(({ input, step }) => {
    const task = step("work").task({
      input: { firstFailurePath: input.firstFailurePath },
      exec: async ({ input }) => {
        const fs = process.getBuiltinModule("node:fs");
        if (!fs.existsSync(input.firstFailurePath)) {
          fs.writeFileSync(input.firstFailurePath, "failed");
          throw new Error("first attempt fails");
        }
        return { ok: true };
      },
    });
    return { ok: task.output.ok };
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

async function waitForTerminalRun(cwd: string, runId: string): Promise<{ status: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = await getRun(cwd, runId);
    if (run && ["completed", "failed", "canceled"].includes(run.status)) return { status: run.status, run };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run '${runId}' did not become terminal.`);
}
