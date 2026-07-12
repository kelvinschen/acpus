import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryLoadRuntimeConfiguration } from "../src/configuration.js";
import type { advanceRuntimeRun as AdvanceRuntimeRun } from "../src/runs/advance-runtime.js";
import type { RunDetails, RuntimeStore } from "../src/store/store.js";

const advanceRuntimeRun = vi.fn<typeof AdvanceRuntimeRun>();

vi.mock("../src/runs/advance-runtime.js", () => ({ advanceRuntimeRun }));

const { RunExecutionSessions } = await import("../src/daemon/sessions.js");

beforeEach(() => {
  advanceRuntimeRun.mockReset().mockImplementation(async () => ({
    status: "completed",
    runId: "run",
    ownerEpoch: 1,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
  }));
});

describe("daemon run execution sessions", () => {
  it("passes one startup runtime configuration snapshot to every run session", async () => {
    const configuration = tryLoadRuntimeConfiguration({
      ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY: "7",
      ACPUS_AGENT_RESPONSE_REPAIR_MAX: "1",
      ACPUS_AGENT_RAW_ACP_DEBUG: "1",
    });
    if (configuration.isErr()) throw new Error(configuration.error.message);
    const runs = new Map([
      ["run-a", run("run-a")],
      ["run-b", run("run-b")],
    ]);
    const store = {
      getRun: (runId: string) => runs.get(runId),
      getLastRunEventSequence: () => 0,
      writeNodeProgress: vi.fn(),
    } as unknown as RuntimeStore;
    const sessions = new RunExecutionSessions("/workspace", store, undefined, configuration.value);

    sessions.start("run-a");
    sessions.start("run-b");
    await vi.waitFor(() => expect(advanceRuntimeRun).toHaveBeenCalledTimes(2));

    for (const call of advanceRuntimeRun.mock.calls) {
      expect(call[4]).toMatchObject({
        maxLeafConcurrency: 7,
        agentHostPolicy: configuration.value.agentHostPolicy,
      });
      expect(call[4]?.agentHostPolicy).toBe(configuration.value.agentHostPolicy);
    }
    await sessions.stopExecutors(100);
  });
});

function run(id: string): RunDetails {
  return {
    id,
    name: id,
    status: "pending",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "sha256:test",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 1,
    execution: { state: "inactive", lastStatus: "pending" },
  };
}
