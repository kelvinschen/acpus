import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineWorkflow, z } from "@acpus/core";
import { admitPreparedWorkflowRun, daemonEndpoint, requestDaemonControl, requestDaemonObserveRun, requestDaemonShutdown, requestDaemonStartRun, requestDaemonStatus, startDaemonLoop } from "../src/index.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { admitSyntheticWorkflow, prepareSyntheticWorkflow, runtimeRows, signalWorkflow, validWorkflow } from "./support/runtime-fixtures.js";

let dir: string;
let store: RuntimeStore;
const ACTIVE_TASK_FALLBACK_MS = 250;

type StoreWithDb = RuntimeStore & {
  db: {
    prepare(sql: string): {
      all(): Array<{ name: string }>;
    };
  };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-daemon-"));
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("daemon lease", () => {
  it("records daemon generations while heartbeat and release stay generation-fenced", () => {
    const base = {
      workspaceRealpath: dir,
      protocolVersion: 1,
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    };

    const first = store.claimDaemon({ ...base, pid: 100 });
    expect(first).toMatchObject({ workspaceRealpath: dir, generation: 1, pid: 100 });

    const second = store.claimDaemon({ ...base, pid: 102 });
    expect(second).toMatchObject({ generation: 2, pid: 102 });

    expect(store.heartbeatDaemon({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.heartbeatDaemon({ workspaceRealpath: dir, generation: second.generation })).toBe(true);
    expect(store.releaseDaemon({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.releaseDaemon({ workspaceRealpath: dir, generation: second.generation })).toBe(true);

    const third = store.claimDaemon({ ...base, pid: 103 });
    expect(third).toMatchObject({ generation: 1, pid: 103 });
  });

  it("stores daemon liveness without endpoint or auth metadata", () => {
    store.claimDaemon({
      workspaceRealpath: dir,
      pid: 100,
      protocolVersion: 1,
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    });

    const columns = storeDbColumns("daemon_lease");
    expect(columns).not.toContain("endpoint");
    expect(columns).not.toContain("auth_token_hash");
  });

  it("serves daemon status on the workspace-derived endpoint", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      expect(daemonEndpoint(dir)).toContain("daemon");
      await expect(requestDaemonStatus(dir)).resolves.toMatchObject({
        status: "ok",
        pid: process.pid,
        generation: expect.any(Number),
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
      });
    } finally {
      await loop.shutdown();
    }
  });

  it("shuts down through the service lifecycle endpoint when idle", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    await expect(requestDaemonShutdown(dir)).resolves.toEqual({ status: "shutdown" });
    await waitUntil(() => store.getRuntimeDiagnostics().daemon === undefined);
    await loop.shutdown();
  });

  it("applies controls through the workspace-derived endpoint", async () => {
    const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-cancel", type: "cancel", runId: awaiting.run.id, input: {} })).resolves.toMatchObject({
        run: { id: awaiting.run.id, status: "canceled" },
      });
    } finally {
      await loop.shutdown();
    }
  });

  it("applies cancel to daemon-owned active execution without lease conflict", async () => {
    const markerPath = join(dir, "active-cancel.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { markerPath });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await waitUntil(() => runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'", admitted.id).length > 0);

      await expect(requestDaemonControl(dir, { requestId: "test-active-cancel", type: "cancel", runId: admitted.id, input: {} })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(requestDaemonObserveRun(dir, admitted.id)).resolves.toMatchObject({
        status: "canceled",
        run: { id: admitted.id, status: "canceled" },
      });
      expect(await readFile(markerPath, "utf8")).toBe("aborted");
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("runs hooks for daemon-owned active controls", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.canceled": [{
        id: "active-canceled",
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.status))"`,
      }],
    }));
    const markerPath = join(dir, "active-cancel-hook.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { markerPath });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await waitUntil(() => runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'", admitted.id).length > 0);
      await expect(requestDaemonControl(dir, { requestId: "test-active-cancel-hook", type: "cancel", runId: admitted.id, input: {} })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await waitUntil(() => store.getHookJournal(admitted.id).length > 0);
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
  }, 5_000);

  it("applies immediate control after start without falling back to a second owner", async () => {
    const markerPath = join(dir, "immediate-cancel.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { markerPath });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await expect(requestDaemonControl(dir, { requestId: "test-immediate-cancel", type: "cancel", runId: admitted.id, input: {} })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(requestDaemonObserveRun(dir, admitted.id)).resolves.toMatchObject({
        status: "canceled",
        run: { id: admitted.id, status: "canceled" },
      });
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("runs configured project hooks from daemon-owned execution", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{
        id: "print-run",
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
      }],
    }));
    const prepared = await prepareSyntheticWorkflow(dir, validWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { ready: true });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await expect(requestDaemonObserveRun(dir, admitted.id)).resolves.toMatchObject({ status: "completed" });
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
  }, 5_000);

  it("runs hooks for short-session signal controls", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "node.completed": [{
        id: "signal-completed",
        match: { nodeId: "^approve$" },
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).node.key))"`,
      }],
    }));
    const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-signal-hook", type: "signal", runId: awaiting.run.id, nodeId: "approve", payload: { ok: true } }))
        .resolves.toMatchObject({ run: { id: awaiting.run.id } });
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
  }, 5_000);

  it("runs hooks for daemon-created fork runs", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{
        id: "fork-completed",
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
      }],
    }));
    const source = await admitSyntheticWorkflow(dir, validWorkflow(), { ready: true });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const fork = await requestDaemonControl(dir, { requestId: "test-fork-hook", type: "fork", runId: source.run.id, input: {} });
      expect(fork.forkRunId).toEqual(expect.any(String));
      await waitUntil(() => store.getHookJournal(fork.forkRunId!).length > 0);
      expect(store.getHookJournal(fork.forkRunId!)).toEqual([
        expect.objectContaining({
          handlerId: "fork-completed",
          event: "run.completed",
          status: "completed",
          stdout: fork.forkRunId,
        }),
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("fails daemon startup for invalid hooks config", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{ command: "" }],
    }));

    await expect(startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    })).rejects.toThrow("Invalid hooks config");
  });

  it("rejects shutdown while a run execution session is active", async () => {
    const markerPath = join(dir, "shutdown-active.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { markerPath });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await waitUntil(() => runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'", admitted.id).length > 0);
      await expect(requestDaemonShutdown(dir)).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
      await expect(requestDaemonControl(dir, { requestId: "test-shutdown-active-cancel", type: "cancel", runId: admitted.id, input: {} })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(requestDaemonObserveRun(dir, admitted.id)).resolves.toMatchObject({ status: "canceled" });
      expect(await readFile(markerPath, "utf8")).toBe("aborted");
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("does not idle-stop while a run execution session is active", async () => {
    const markerPath = join(dir, "idle-active.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const admitted = await admitPreparedWorkflowRun(dir, prepared, { markerPath });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      idleStopMs: 20,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStartRun(dir, admitted.id)).resolves.toMatchObject({ id: admitted.id });
      await new Promise(resolve => setTimeout(resolve, 50));
      await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
      await expect(requestDaemonControl(dir, { requestId: "test-idle-active-cancel", type: "cancel", runId: admitted.id, input: {} })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(requestDaemonObserveRun(dir, admitted.id)).resolves.toMatchObject({ status: "canceled" });
    } finally {
      await loop.shutdown();
    }
  }, 15_000);

  it("returns stable daemon control error codes", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-missing", type: "cancel", runId: "run_missing", input: {} }))
        .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    } finally {
      await loop.shutdown();
    }
  });

  it("returns control conflict for reused fork request ids with different input", async () => {
    const source = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "fork-conflict", type: "fork", runId: source.run.id, input: { target: "approve" } }))
        .resolves.toMatchObject({ forkRunId: expect.any(String) });
      await expect(requestDaemonControl(dir, { requestId: "fork-conflict", type: "fork", runId: source.run.id, input: {} }))
        .rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
    } finally {
      await loop.shutdown();
    }
  });

  it("uses socket binding as the single-instance authority", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
    } finally {
      await loop.shutdown();
    }
  });

  it("removes a stale filesystem socket before binding", async () => {
    const endpoint = daemonEndpoint(dir);
    if (endpoint.startsWith("\0") || process.platform === "win32") return;
    await mkdir(dirname(endpoint), { recursive: true });
    await writeFile(endpoint, "stale socket");

    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
    } finally {
      await loop.shutdown();
    }
  });

  it("does not remove an unresponsive socket path while daemon diagnostics are fresh", async () => {
    const endpoint = daemonEndpoint(dir);
    if (endpoint.startsWith("\0") || process.platform === "win32") return;
    store.claimDaemon({
      workspaceRealpath: dir,
      pid: process.pid,
      protocolVersion: 1,
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    });
    await mkdir(dirname(endpoint), { recursive: true });
    await writeFile(endpoint, "not a socket");

    await expect(startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("destroys half-open sockets during shutdown", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    const socket = connect(daemonEndpoint(dir));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await expect(loop.shutdown()).resolves.toBeUndefined();
    socket.destroy();
  });
});

function activeTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-active-cancel",
    inputSchema: z.object({ markerPath: z.string().optional() }),
  }).build(({ input, step }) => {
    const task = step("slow_task").task({
      run: {
        input: { markerPath: input.markerPath, fallbackMs: ACTIVE_TASK_FALLBACK_MS },
        exec: async ({ input, abortSignal }) => await new Promise<{ ok: boolean }>(resolve => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (marker: string) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (input.markerPath) process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, marker);
            resolve({ ok: false });
          };
          timer = setTimeout(() => {
            finish("fallback");
          }, input.fallbackMs);
          abortSignal.addEventListener("abort", () => {
            finish("aborted");
          }, { once: true });
          if (abortSignal.aborted) finish("aborted");
        }),
      },
    });
    return { ok: task.output.ok };
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

function storeDbColumns(table: string): string[] {
  return (store as StoreWithDb)
    .db.prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => row.name);
}
