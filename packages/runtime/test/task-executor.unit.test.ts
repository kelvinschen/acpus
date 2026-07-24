import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, okAsync } from "neverthrow";
import type { TaskExecutorOptions } from "../src/execution/task-executor.js";
import { executeTaskNode } from "../src/execution/task-executor.js";
import type { RegisterArtifactInput } from "../src/store/store.js";
import { inlineTask } from "./support/task-executor-fixture.js";
import type { TaskAttemptRunner } from "./support/task-attempt-harness.js";

const taskProcessMocks = vi.hoisted(() => ({
  runTaskAttempt: vi.fn<TaskAttemptRunner>(),
}));

vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: taskProcessMocks.runTaskAttempt,
}));

beforeEach(() => {
  taskProcessMocks.runTaskAttempt.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task executor rules", () => {
  it("returns a typed resolution failure before starting a Task attempt", async () => {
    const result = await executeTaskNode(inlineTask("bad_cwd", "async () => undefined", {
      cwd: { kind: "literal", value: 42 },
    }), {}, taskOptions("run_bad_cwd"));

    expect(result.isErr() && result.error).toMatchObject({
      type: "resolution",
      error: {
        type: "type",
        field: "Task node 'bad_cwd' cwd",
        expected: "string",
        actual: "number",
      },
    });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("passes a distant deadline to the Task attempt without timer overflow", async () => {
    const deadlineAt = new Date(Date.now() + 2_147_483_647 + 60_000).toISOString();
    taskProcessMocks.runTaskAttempt.mockReturnValue(okAsync({ ok: true }));

    const result = await executeTaskNode(
      inlineTask("distant", "async () => ({ ok: true })"),
      {},
      { ...taskOptions("run_distant"), deadlineAt },
    );

    expect(result.isOk() ? result.value : undefined).toEqual({ ok: true });
    expect(taskProcessMocks.runTaskAttempt).toHaveBeenCalledOnce();
    expect(taskProcessMocks.runTaskAttempt.mock.calls[0]?.[0].timeoutMs)
      .toBeGreaterThan(2_147_483_647);
  });

  it("returns timed_out when setup exhausts the deadline before the Task attempt", async () => {
    const startedAt = new Date("2026-07-10T00:00:00.000Z").getTime();
    let now = startedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const options = taskOptions("run_setup_timeout");
    options.store.writeExecutionMetadata = () => {
      now += 100;
    };

    const result = await executeTaskNode(
      inlineTask("setup_timeout", "async () => ({ ok: true })"),
      {},
      { ...options, deadlineAt: new Date(startedAt + 50).toISOString() },
    );

    expect(result.isErr() && result.error).toMatchObject({ type: "timed_out" });
    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted deadline before starting the Task attempt", async () => {
    await expect(executeTaskNode(
      inlineTask("bad_deadline", "async () => ({ ok: true })"),
      {},
      { ...taskOptions("run_bad_deadline"), deadlineAt: "not-a-deadline" },
    )).rejects.toBeInstanceOf(Error);

    expect(taskProcessMocks.runTaskAttempt).not.toHaveBeenCalled();
  });
});

function taskOptions(runId: string): TaskExecutorOptions {
  return {
    cwd: process.cwd(),
    runId,
    attemptId: `attempt_${runId}`,
    attemptNo: 1,
    ownerEpoch: 1,
    store: {
      getRunDir: () => join(process.cwd(), ".tmp-tests", runId),
      getArtifact: () => undefined,
      registerArtifact: (_input: RegisterArtifactInput) => ok(undefined),
      writeExecutionMetadata: () => {},
    },
  };
}
