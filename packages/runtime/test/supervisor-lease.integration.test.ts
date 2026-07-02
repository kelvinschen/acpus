import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";

let dir: string;
let store: RuntimeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-supervisor-"));
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("supervisor lease", () => {
  it("fences active leases, allows stale takeover, heartbeats, and release by generation", () => {
    const base = {
      workspaceRealpath: dir,
      endpoint: "http://127.0.0.1:1",
      tokenHash: "token",
      protocolVersion: 1,
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    };

    const first = store.claimSupervisor({ ...base, pid: 100, staleAfterMs: 60_000 });
    expect(first).toMatchObject({ workspaceRealpath: dir, generation: 1, pid: 100 });

    expect(() => store.claimSupervisor({ ...base, pid: 101, staleAfterMs: 60_000 })).toThrow("still active");
    expect(store.heartbeatSupervisor({ workspaceRealpath: dir, generation: first.generation })).toBe(true);
    expect(store.heartbeatSupervisor({ workspaceRealpath: dir, generation: first.generation + 1 })).toBe(false);

    const second = store.claimSupervisor({ ...base, pid: 102, staleAfterMs: -1 });
    expect(second).toMatchObject({ generation: 2, pid: 102 });
    expect(store.heartbeatSupervisor({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.releaseSupervisor({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.releaseSupervisor({ workspaceRealpath: dir, generation: second.generation })).toBe(true);

    const third = store.claimSupervisor({ ...base, pid: 103, staleAfterMs: 60_000 });
    expect(third).toMatchObject({ generation: 1, pid: 103 });
  });
});
