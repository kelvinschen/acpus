import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDaemonLoop } from "./support/daemon-loop.js";
import {
  admitSyntheticWorkflow,
  prepareSyntheticWorkflow,
  runtimeRows,
  signalWorkflow,
  validWorkflow,
} from "./support/runtime-fixtures.js";
import {
  activeTaskWorkflow,
  requestDaemonControl,
  waitForTerminalRun,
  waitUntil,
  withDaemonLeaseWorkspace,
} from "./support/daemon-lease-fixture.js";
import { submitRunThroughDaemon } from "./support/daemon-submit.js";

describe.concurrent("daemon lease hooks", () => {
  it("runs hooks for daemon-owned active controls", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const sideEffectPath = join(dir, "active-cancel-hook-side-effect.marker");
      await mkdir(join(dir, ".acpus"), { recursive: true });
      await writeFile(join(dir, ".acpus", "config.json"), JSON.stringify({ hooks: {
        "run.canceled": [{
          id: "active-canceled",
          command: `${process.execPath} -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{require("node:fs").appendFileSync(${JSON.stringify(sideEffectPath)},"fired\\n");process.stdout.write(JSON.parse(s).run.status)})'`,
        }],
      } }));
      const markerPath = join(dir, "active-cancel-hook.marker");
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
        await expect(requestDaemonControl(dir, {
          requestId: "test-active-cancel-hook",
          type: "cancel",
          runId: admitted.id,
        })).resolves.toMatchObject({
          run: { id: admitted.id, status: "canceled" },
        });
        await expect(waitForTerminalRun(dir, admitted.id))
          .resolves.toMatchObject({ status: "canceled" });
        await loop.shutdown();
        await expect(readFile(sideEffectPath, "utf8")).resolves.toBe("fired\n");
        expect(store.getHookJournal(admitted.id)).toEqual([
          expect.objectContaining({
            handlerId: "active-canceled",
            event: "run.canceled",
            status: "completed",
            stdout: "canceled",
          }),
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("runs configured project hooks from daemon-owned execution", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      await mkdir(join(dir, ".acpus"), { recursive: true });
      await writeFile(join(dir, ".acpus", "config.json"), JSON.stringify({ hooks: {
        "run.completed": [{
          id: "print-run",
          command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
        }],
      } }));
      const prepared = await prepareSyntheticWorkflow(dir, validWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const admitted = await submitRunThroughDaemon(dir, {
          prepared,
          input: { ready: true },
        });
        await expect(waitForTerminalRun(dir, admitted.id))
          .resolves.toMatchObject({ status: "completed" });
        await waitUntil(() => store.getHookJournal(admitted.id).length > 0);
        expect(store.getHookJournal(admitted.id)).toEqual([
          expect.objectContaining({
            handlerId: "print-run",
            event: "run.completed",
            status: "completed",
            stdout: admitted.id,
          }),
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("runs hooks for short-session signal controls", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      await mkdir(join(dir, ".acpus"), { recursive: true });
      await writeFile(join(dir, ".acpus", "config.json"), JSON.stringify({ hooks: {
        "node.completed": [{
          id: "signal-completed",
          match: { nodeId: "^approve$" },
          command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).node.key))"`,
        }],
      } }));
      const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonControl(dir, {
          requestId: "test-signal-hook",
          type: "signal",
          runId: awaiting.run.id,
          nodeId: "approve",
          payload: { ok: true },
        })).resolves.toMatchObject({
          type: "signal",
          state: "consumed",
          requestedTarget: "approve",
          target: expect.stringMatching(/^approve~[0-9a-f]{8}$/),
          validation: { kind: "schema", schemaSummary: "{ ok: boolean }" },
          run: { id: awaiting.run.id },
        });
        await waitUntil(() => store.getHookJournal(awaiting.run.id).length > 0);
        expect(store.getHookJournal(awaiting.run.id)).toEqual([
          expect.objectContaining({
            handlerId: "signal-completed",
            event: "node.completed",
            status: "completed",
            stdout: expect.stringMatching(/^approve/),
          }),
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("runs hooks for daemon-created fork runs", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      await mkdir(join(dir, ".acpus"), { recursive: true });
      await writeFile(join(dir, ".acpus", "config.json"), JSON.stringify({ hooks: {
        "run.completed": [{
          id: "fork-completed",
          command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
        }],
      } }));
      const source = await admitSyntheticWorkflow(dir, validWorkflow(), { ready: true });
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      });
      try {
        const fork = await requestDaemonControl(dir, {
          requestId: "test-fork-hook",
          type: "fork",
          runId: source.run.id,
        });
        expect(fork).toMatchObject({
          type: "fork",
          state: "applied",
          sourceRunId: source.run.id,
        });
        expect(fork.run.id).not.toBe(source.run.id);
        await waitUntil(() => store.getHookJournal(fork.run.id).length > 0);
        expect(store.getHookJournal(fork.run.id)).toEqual([
          expect.objectContaining({
            handlerId: "fork-completed",
            event: "run.completed",
            status: "completed",
            stdout: fork.run.id,
          }),
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  }, 5_000);

  it("fails daemon startup for invalid hooks config without claiming the daemon", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      await mkdir(join(dir, ".acpus"), { recursive: true });
      await writeFile(join(dir, ".acpus", "config.json"), JSON.stringify({ hooks: {
        "run.completed": [{ command: "" }],
      } }));

      await expect(startDaemonLoop(dir, {
        heartbeatMs: 10,
        packageVersion: "0.0.0-test",
      })).rejects.toBeInstanceOf(Error);
      expect(store.getRuntimeDiagnostics().authority).toBeUndefined();
    });
  });
});
