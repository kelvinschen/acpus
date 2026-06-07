import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/store.js";
import type { AcpusIr } from "@acpus/core";
import type { NodeExecutionState } from "../src/types.js";

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
        state: "completed",
        attempt: 1,
        startedAt: "2025-01-01T00:00:00Z",
        completedAt: "2025-01-01T00:01:00Z",
        output: { result: "done" }
      };

      store.writeNodeState("run-001", state);
      const read = store.readNodeState("run-001", "workflow/step-a");

      expect(read).toEqual(state);
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
});
