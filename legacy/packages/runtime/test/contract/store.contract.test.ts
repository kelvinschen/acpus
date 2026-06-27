import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../../src/store.js";
import { nodeKeyToStorageKey } from "../../src/keys.js";
import type { AcpusIr } from "@acpus/core";
import type { NodeExecutionState } from "../../src/types.js";

function makeIr(name = "test-workflow"): AcpusIr {
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

describe("RunStore", () => {
  let tmpDir: string;
  let store: RunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-test-"));
    store = new RunStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initRun", () => {
    it("creates a run directory with IR and input snapshots", () => {
      const ir = makeIr();
      const input = { key: "value" };
      const meta = store.initRun("run-001", ir, input);

      expect(meta.runId).toBe("run-001");
      expect(meta.workflowName).toBe("test-workflow");
      expect(meta.status).toBe("running");
      expect(meta.runAttempt).toBe(1);
      expect(meta.irDigest).toMatch(/^sha256:/);
      expect(meta.inputDigest).toMatch(/^sha256:/);

      const readIr = store.readIr("run-001");
      expect(readIr).toBeDefined();
      expect(readIr!.name).toBe("test-workflow");

      const readInput = store.readInput("run-001");
      expect(readInput).toEqual({ key: "value" });
    });
  });

  describe("writeNodeState / readNodeState", () => {
    it("round-trips node state", () => {
      const ir = makeIr();
      store.initRun("run-001", ir, {});

      const state: NodeExecutionState = {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.agent",
        definitionHash: "sha256:step-a",
        state: "completed",
        attempt: 1,
        startedAt: "2025-01-01T00:00:00Z",
        completedAt: "2025-01-01T00:01:00Z",
        output: { result: "done" }
      };

      store.writeNodeState("run-001", state);
      const read = store.readNodeState("run-001", "workflow/step-a");

      expect(read).toEqual(state);
      expect(store.readCheckpoints("run-001")).toEqual([]);
    });

    it("persists node state under bounded storage keys and indexes it for audit", () => {
      store.initRun("run-001", makeIr(), {});
      const nodeKey = `workflow/${"very-long-segment-".repeat(30)}/step-a`;
      const storageKey = nodeKeyToStorageKey(nodeKey);
      const state: NodeExecutionState = {
        nodeKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "running",
        attempt: 1
      };

      store.writeNodeState("run-001", state);

      const statePath = join(tmpDir, "run-001", "nodes", `${storageKey}.json`);
      expect(existsSync(statePath)).toBe(true);
      expect(readFileSync(statePath, "utf8")).toContain(nodeKey);
      expect(store.readNodeState("run-001", nodeKey)).toEqual(state);

      const index = readFileSync(join(tmpDir, "run-001", "node-index.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(index).toEqual([{
        nodeKey,
        storageKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "running",
        statePath: `nodes/${storageKey}.json`,
        artifactDir: `artifacts/${storageKey}`
      }]);
    });

    it("upserts node-index entries when a node state changes", () => {
      store.initRun("run-001", makeIr(), {});
      const nodeKey = "workflow/step-a";

      store.writeNodeState("run-001", {
        nodeKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "running",
        attempt: 1
      });
      store.writeNodeState("run-001", {
        nodeKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "completed",
        attempt: 1
      });

      const lines = readFileSync(join(tmpDir, "run-001", "node-index.jsonl"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).state).toBe("completed");
    });

    it("rebuilds node-index from node states when the existing index is corrupt", () => {
      store.initRun("run-001", makeIr(), {});
      const firstNodeKey = "workflow/step-a";
      const secondNodeKey = "workflow/step-b";
      const firstState: NodeExecutionState = {
        nodeKey: firstNodeKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "completed",
        attempt: 1
      };

      store.writeNodeState("run-001", firstState);
      writeFileSync(join(tmpDir, "run-001", "node-index.jsonl"), "{not-json}\n", "utf8");
      expect(store.readNodeState("run-001", firstNodeKey)).toEqual(firstState);
      store.writeNodeState("run-001", {
        nodeKey: secondNodeKey,
        nodeId: "step-b",
        kind: "run.program",
        state: "running",
        attempt: 1
      });

      const entries = readFileSync(join(tmpDir, "run-001", "node-index.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.nodeKey)).toEqual([firstNodeKey, secondNodeKey]);
      expect(entries).toContainEqual(expect.objectContaining({
        nodeKey: firstNodeKey,
        storageKey: nodeKeyToStorageKey(firstNodeKey),
        state: "completed"
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        nodeKey: secondNodeKey,
        storageKey: nodeKeyToStorageKey(secondNodeKey),
        state: "running"
      }));
    });

    it("reads node state without node-index", () => {
      store.initRun("run-001", makeIr(), {});
      const nodeKey = "workflow/step-a";
      const state: NodeExecutionState = {
        nodeKey,
        nodeId: "step-a",
        kind: "run.program",
        state: "completed",
        attempt: 1
      };

      store.writeNodeState("run-001", state);
      unlinkSync(join(tmpDir, "run-001", "node-index.jsonl"));

      expect(store.readNodeState("run-001", nodeKey)).toEqual(state);
    });

    it("records a checkpoint for a checkpointable terminal state write", () => {
      store.initRun("run-001", makeIr(), {});

      store.writeTerminalNodeState("run-001", {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.program",
        definitionHash: "sha256:step-a",
        state: "completed",
        attempt: 1,
        completedAt: "2025-01-01T00:01:00Z"
      });

      expect(store.readCheckpoints("run-001")).toEqual([{
        sequence: 1,
        nodeKey: "workflow/step-a",
        state: "completed",
        definitionHash: "sha256:step-a",
        completedAt: "2025-01-01T00:01:00Z"
      }]);
    });

    it("rejects non-terminal writes through the terminal state API", () => {
      store.initRun("run-001", makeIr(), {});

      expect(() => store.writeTerminalNodeState("run-001", {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.program",
        definitionHash: "sha256:step-a",
        state: "running",
        attempt: 1
      })).toThrow(/not terminal/);
    });

    it("replaces a checkpoint for the same Node Key while preserving sequence", () => {
      store.initRun("run-001", makeIr(), {});

      store.writeTerminalNodeState("run-001", {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.program",
        definitionHash: "sha256:step-a",
        state: "failed",
        attempt: 1,
        completedAt: "2025-01-01T00:01:00Z",
        error: "boom"
      });
      store.writeTerminalNodeState("run-001", {
        nodeKey: "workflow/step-b",
        nodeId: "step-b",
        kind: "run.program",
        definitionHash: "sha256:step-b",
        state: "completed",
        attempt: 1,
        completedAt: "2025-01-01T00:02:00Z"
      });
      store.writeTerminalNodeState("run-001", {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.program",
        definitionHash: "sha256:step-a",
        state: "completed",
        attempt: 2,
        completedAt: "2025-01-01T00:03:00Z"
      });

      expect(store.readCheckpoints("run-001")).toEqual([
        {
          sequence: 1,
          nodeKey: "workflow/step-a",
          state: "completed",
          definitionHash: "sha256:step-a",
          completedAt: "2025-01-01T00:03:00Z"
        },
        {
          sequence: 2,
          nodeKey: "workflow/step-b",
          state: "completed",
          definitionHash: "sha256:step-b",
          completedAt: "2025-01-01T00:02:00Z"
        }
      ]);
    });

    it("returns undefined for missing key", () => {
      const ir = makeIr();
      store.initRun("run-001", ir, {});

      expect(store.readNodeState("run-001", "nonexistent")).toBeUndefined();
    });
  });

  describe("listNodeStates", () => {
    it("lists all node states", () => {
      const ir = makeIr();
      store.initRun("run-001", ir, {});

      store.writeNodeState("run-001", {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.agent",
        state: "completed",
        attempt: 1
      });
      store.writeNodeState("run-001", {
        nodeKey: "workflow/step-b",
        nodeId: "step-b",
        kind: "run.program",
        state: "pending",
        attempt: 0
      });

      const states = store.listNodeStates("run-001");
      expect(states).toHaveLength(2);
    });
  });

  describe("writeRunMeta / readRunMeta", () => {
    it("round-trips run metadata", () => {
      const ir = makeIr();
      const meta = store.initRun("run-001", ir, {});

      meta.status = "completed";
      meta.updatedAt = new Date().toISOString();
      store.writeRunMeta("run-001", meta);

      const read = store.readRunMeta("run-001");
      expect(read!.status).toBe("completed");
    });
  });

  describe("atomic writes", () => {
    it("persists without tmp file left", () => {
      const ir = makeIr();
      store.initRun("run-001", ir, {});

      const state: NodeExecutionState = {
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.agent",
        state: "running",
        attempt: 1
      };
      store.writeNodeState("run-001", state);

      // Should not have tmp files lingering
      const nodesDir = join(tmpDir, "run-001", "nodes");
      const files = readdirSync(nodesDir);
      expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
    });
  });

  describe("listRunIds", () => {
    it("lists all run IDs", () => {
      store.initRun("run-001", makeIr("w1"), {});
      store.initRun("run-002", makeIr("w2"), {});

      const ids = store.listRunIds();
      expect(ids).toContain("run-001");
      expect(ids).toContain("run-002");
    });

    it("returns empty array when no runs", () => {
      expect(store.listRunIds()).toEqual([]);
    });
  });

  describe("cleanTerminalRuns", () => {
    it("deletes terminal runs and preserves running and paused runs", () => {
      const completed = store.initRun("completed-run", makeIr("done"), {});
      completed.status = "completed";
      store.writeRunMeta(completed.runId, completed);

      const failed = store.initRun("failed-run", makeIr("failed"), {});
      failed.status = "failed";
      store.writeRunMeta(failed.runId, failed);

      store.initRun("running-run", makeIr("running"), {});

      const paused = store.initRun("paused-run", makeIr("paused"), {});
      paused.status = "paused";
      store.writeRunMeta(paused.runId, paused);

      const result = store.cleanTerminalRuns();

      expect(result.deleted.map((item) => item.runId).sort()).toEqual(["completed-run", "failed-run"]);
      expect(result.skipped.map((item) => item.runId).sort()).toEqual(["paused-run", "running-run"]);
      expect(store.hasRun("running-run")).toBe(true);
      expect(store.hasRun("paused-run")).toBe(true);
      expect(existsSync(join(tmpDir, "completed-run"))).toBe(false);
      expect(existsSync(join(tmpDir, "failed-run"))).toBe(false);
    });

    it("supports dry-run without deleting", () => {
      const meta = store.initRun("completed-run", makeIr("done"), {});
      meta.status = "completed";
      store.writeRunMeta(meta.runId, meta);

      const result = store.cleanTerminalRuns({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(store.hasRun("completed-run")).toBe(true);
    });

    it("skips corrupt run metadata", () => {
      mkdirSync(join(tmpDir, "corrupt-run"), { recursive: true });
      writeFileSync(join(tmpDir, "corrupt-run", "run-meta.json"), "{ nope", "utf8");

      const result = store.cleanTerminalRuns();

      expect(result.deletedCount).toBe(0);
      expect(result.skipped[0]).toMatchObject({ runId: "corrupt-run", reason: "corrupt-metadata" });
      expect(existsSync(join(tmpDir, "corrupt-run"))).toBe(true);
    });

    it("does not follow symlinks when estimating bytes", () => {
      const meta = store.initRun("completed-run", makeIr("done"), {});
      meta.status = "completed";
      store.writeRunMeta(meta.runId, meta);
      symlinkSync(join(tmpDir, "completed-run"), join(tmpDir, "completed-run", "self"), "dir");

      const result = store.cleanTerminalRuns({ dryRun: true });

      expect(result.deletedCount).toBe(1);
      expect(result.deleted[0]?.bytes).toBeGreaterThan(0);
    });
  });
});
