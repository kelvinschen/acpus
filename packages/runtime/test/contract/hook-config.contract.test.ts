import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../../src/store.js";
import { materializeForkedRun } from "../../src/fork.js";
import { createInitialNodeState } from "../../src/state-machine.js";
import type { AcpusIr, HookConfigSnapshot } from "@acpus/core";

function makeIr(name = "hook-config-wf"): AcpusIr {
  return {
    irVersion: 1,
    astVersion: 1,
    source: { digest: "sha256:abc123" },
    name,
    input: {},
    agents: {},
    root: {
      id: "workflow",
      kind: "pipeline",
      nodePath: ["workflow"],
      keyTemplate: { astVersion: 1, nodePath: "workflow" },
      children: [],
      metadata: {}
    },
    outputs: {},
    expressions: []
  };
}

const snapshot: HookConfigSnapshot = {
  hash: "sha256:deadbeef",
  globalConfigPath: "/home/u/.acpus/hooks.yaml",
  projectConfigPath: "/ws/.acpus/hooks.yaml",
  mergedConfig: { events: { afterRun: [{ command: "notify.sh" }] } }
};

describe("RunStore hook configuration", () => {
  let tmpDir: string;
  let store: RunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-hookcfg-"));
    store = new RunStore(tmpDir);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a hook-config snapshot", () => {
    store.initRun("run-1", makeIr(), {});
    expect(store.hasHookConfig("run-1")).toBe(false);
    store.writeHookConfig("run-1", snapshot);
    expect(store.hasHookConfig("run-1")).toBe(true);
    expect(store.readHookConfig("run-1")).toEqual(snapshot);
    expect(existsSync(join(tmpDir, "run-1", "hook-config.json"))).toBe(true);
  });

  it("does not create a hook-config file when none is written", () => {
    store.initRun("run-2", makeIr(), {});
    expect(store.readHookConfig("run-2")).toBeUndefined();
    expect(existsSync(join(tmpDir, "run-2", "hook-config.json"))).toBe(false);
  });

  it("persists hookConfigHash on run metadata when set", () => {
    const meta = store.initRun("run-3", makeIr(), {});
    expect(meta.hookConfigHash).toBeUndefined();
    meta.hookConfigHash = snapshot.hash;
    store.writeRunMeta("run-3", meta);
    expect(store.readRunMeta("run-3")?.hookConfigHash).toBe(snapshot.hash);
  });

  it("a forked run inherits the source run's frozen hook configuration", () => {
    const ir = makeIr();
    // Source run with a completed leaf checkpoint and a frozen hook config.
    store.initRun("source", ir, {});
    store.writeNodeState("source", {
      ...createInitialNodeState("workflow", "workflow", "pipeline", ir.root.keyTemplate ? "sha256:x" : undefined),
      state: "completed",
      completedAt: new Date().toISOString()
    });
    store.writeHookConfig("source", snapshot);
    const srcMeta = store.readRunMeta("source")!;
    srcMeta.status = "completed";
    srcMeta.hookConfigHash = snapshot.hash;
    store.writeRunMeta("source", srcMeta);

    materializeForkedRun(store, {
      sourceRunId: "source",
      forkRunId: "fork",
      ir,
      plan: { sourceRunId: "source", inheritedNodeKeys: [], defaultForkOriginNodeKey: "workflow", forkOriginNodeKey: "workflow", boundaryReason: "all-completed" }
    });

    expect(store.readHookConfig("fork")).toEqual(snapshot);
    expect(store.readRunMeta("fork")?.hookConfigHash).toBe(snapshot.hash);
  });

  it("a forked run inherits skipHooks metadata from a skipped source run", () => {
    const ir = makeIr();
    store.initRun("source", ir, {}, { skipHooks: true });
    store.writeNodeState("source", {
      ...createInitialNodeState("workflow", "workflow", "pipeline", ir.root.keyTemplate ? "sha256:x" : undefined),
      state: "completed",
      completedAt: new Date().toISOString()
    });
    const srcMeta = store.readRunMeta("source")!;
    srcMeta.status = "completed";
    store.writeRunMeta("source", srcMeta);

    materializeForkedRun(store, {
      sourceRunId: "source",
      forkRunId: "fork",
      ir,
      skipHooks: srcMeta.skipHooks,
      plan: { sourceRunId: "source", inheritedNodeKeys: [], defaultForkOriginNodeKey: "workflow", forkOriginNodeKey: "workflow", boundaryReason: "all-completed" }
    });

    expect(store.readRunMeta("fork")?.skipHooks).toBe(true);
    expect(store.readRunMeta("fork")?.hookConfigHash).toBeUndefined();
    expect(store.hasHookConfig("fork")).toBe(false);
  });
});
