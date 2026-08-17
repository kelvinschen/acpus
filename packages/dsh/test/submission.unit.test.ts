import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import type { RunLinkStore } from "../src/host/run-links.js";
import { submitPreparedWorkflow } from "../src/host/submission.js";

describe("DSH admission outcome recovery", () => {
  it("replays an unknown outcome once with the same admission identity", async () => {
    const run = { id: "run-1", name: "review" };
    const submit = vi.fn()
      .mockReturnValueOnce(errAsync(submitFailure("unknown", "STORE_BUSY")))
      .mockReturnValueOnce(okAsync(run));
    const runtime = runtimeStub(submit, vi.fn(() => okAsync(undefined)));
    const admitted = vi.fn(async () => admittedLink());

    await expect(submitPreparedWorkflow(input(runtime, admitted))).resolves.toEqual({
      status: "admitted",
      runId: "run-1",
      task: { name: "review", occurrence: 1 },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
    expect(admitted).toHaveBeenCalledWith("admission-1", run);
  });

  it("recovers an admitted outcome from the durable receipt without replaying", async () => {
    const run = { id: "run-1", name: "review" };
    const submit = vi.fn(() => errAsync(submitFailure("admitted", "EXECUTION_UNAVAILABLE")));
    const runtime = runtimeStub(submit, vi.fn(() => okAsync(run)));
    const admitted = vi.fn(async () => admittedLink());

    await expect(submitPreparedWorkflow(input(runtime, admitted))).resolves.toMatchObject({
      status: "admitted",
      runId: "run-1",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(admitted).toHaveBeenCalledWith("admission-1", run);
  });

  it("preserves an unresolved provisional admission and returns a stable code", async () => {
    const submit = vi.fn(() => errAsync(submitFailure("unknown", "STORE_BUSY")));
    const runtime = runtimeStub(submit, vi.fn(() => okAsync(undefined)));
    const admitted = vi.fn(async () => admittedLink());

    await expect(submitPreparedWorkflow(input(runtime, admitted))).rejects.toMatchObject({
      code: "ACPUS_ADMISSION_OUTCOME_UNKNOWN",
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(admitted).not.toHaveBeenCalled();
  });

  it("does not replay when the durable receipt cannot be read", async () => {
    const submit = vi.fn(() => errAsync(submitFailure("unknown", "STORE_BUSY")));
    const runtime = runtimeStub(submit, vi.fn(() => errAsync({
      type: "runtime-store-unavailable" as const,
      message: "store unavailable",
    })));
    const admitted = vi.fn(async () => admittedLink());

    await expect(submitPreparedWorkflow(input(runtime, admitted))).rejects.toMatchObject({
      code: "ACPUS_ADMISSION_OUTCOME_UNKNOWN",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(admitted).not.toHaveBeenCalled();
  });
});

function input(
  runtime: WorkspaceRuntime,
  admitted: ReturnType<typeof vi.fn>,
): Parameters<typeof submitPreparedWorkflow>[0] {
  return {
    runtime,
    prepared: {} as never,
    normalizedInput: {},
    admissionRequestId: "admission-1",
    link: {
      workspace: "/workspace",
      admissionRequestId: "admission-1",
      parentSessionId: "session-1",
      generation: 1,
    },
    links: { admitted } as unknown as RunLinkStore,
  };
}

function runtimeStub(
  submit: ReturnType<typeof vi.fn>,
  findAdmission: ReturnType<typeof vi.fn>,
): WorkspaceRuntime {
  return { submit, findAdmission } as unknown as WorkspaceRuntime;
}

function submitFailure(
  outcome: "admitted" | "unknown",
  code: "STORE_BUSY" | "EXECUTION_UNAVAILABLE",
) {
  return {
    type: "runtime-submit-failed" as const,
    outcome,
    code,
    message: "submission did not return a receipt",
  };
}

function admittedLink() {
  return {
    workspace: "/workspace",
    admissionRequestId: "admission-1",
    parentSessionId: "session-1",
    generation: 1,
    runId: "run-1",
    workflowName: "review",
    occurrence: 1,
  };
}
