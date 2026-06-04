import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunDiagnosticsView, readNdjsonTail } from "../../src/projections/run-diagnostics.js";
import { appendEvent, RuntimeErrorCodes, type RunIndex } from "../../src/run-index/read-write.js";

describe("RunDiagnosticsView", () => {
  it("projects run-index diagnostics and bounded event tail", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-diagnostics-"));
    const index = runIndex({
      logicalRunId: "diagnostics-run",
      status: "blocked",
      blockedReason: RuntimeErrorCodes.GATE_VERDICT_UNKNOWN,
      gateVerdict: "unknown"
    });
    await appendEvent(cwd, index.logicalRunId, { type: "older", sequence: 1 });
    await appendEvent(cwd, index.logicalRunId, { type: "turn_finished", stageId: "gate", errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED });
    await appendEvent(cwd, index.logicalRunId, { type: "runtime_fatal", code: RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT, error: "Lock file is already being held" });

    const view = await buildRunDiagnosticsView(cwd, index, { eventTailLimit: 2 });

    expect(view.version).toBe("acpus.diagnostics/v1");
    expect(view.run).toMatchObject({
      logicalRunId: "diagnostics-run",
      status: "blocked",
      blockedReason: RuntimeErrorCodes.GATE_VERDICT_UNKNOWN
    });
    expect(view.eventTail.map((event) => event.type)).toEqual(["turn_finished", "runtime_fatal"]);
    expect(view.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.GATE_VERDICT_UNKNOWN,
      source: "run_index"
    }));
    expect(view.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT,
      source: "event_tail"
    }));
  });

  it("surfaces stable loop and variable runtime codes from the run index", async () => {
    for (const code of [
      RuntimeErrorCodes.LOOP_EXHAUSTED,
      RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED,
      RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED,
      RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING,
      RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED
    ]) {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-diagnostics-code-"));
      const index = runIndex({
        logicalRunId: `diagnostics-${code}`,
        status: "blocked",
        blockedReason: code
      });

      const view = await buildRunDiagnosticsView(cwd, index, { eventTailLimit: 0 });

      expect(view.diagnostics).toContainEqual(expect.objectContaining({
        code,
        source: "run_index"
      }));
    }
  });

  it("reads only the bounded tail of an ndjson file", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-ndjson-tail-"));
    const filePath = path.join(cwd, "events.ndjson");
    await fs.writeFile(filePath, Array.from({ length: 20 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join("\n") + "\n", "utf8");

    const lines = await readNdjsonTail(filePath, 3, 128);

    expect(lines.map((line) => JSON.parse(line) as { sequence: number }).map((event) => event.sequence)).toEqual([18, 19, 20]);
  });
});

function runIndex(input: Partial<RunIndex>): RunIndex {
  const now = new Date().toISOString();
  return {
    schemaVersion: "acpus.run/v2",
    logicalRunId: input.logicalRunId ?? "run",
    workflowName: "diagnostics-workflow",
    status: input.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    stages: {},
    attempts: {},
    agentUsage: {
      planned: 0,
      actual: 0,
      retryCalls: 0,
      retries: { runtime: 0, stale: 0, continuation: 0 }
    },
    blockedReason: input.blockedReason,
    gateVerdict: input.gateVerdict
  };
}
