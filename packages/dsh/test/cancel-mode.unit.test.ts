import { describe, expect, it, vi } from "vitest";
import { AcpusMode } from "../src/host/mode.js";

describe("Acpus Tray cancellation", () => {
  it("resolves exact selectors and defaults omission to the latest task", async () => {
    const mode = Object.create(AcpusMode.prototype) as AcpusMode;
    const runs = [
      { runId: "run-1", name: "review", occurrence: 1, generation: 1, workspace: "/one" },
      { runId: "run-2", name: "review", occurrence: 2, generation: 2, workspace: "/two" },
      { runId: "run-3", name: "audit", occurrence: 1, generation: 3, workspace: "/three" },
    ];
    const links = runs.map(run => ({
      workspace: run.workspace,
      admissionRequestId: `admission-${run.runId}`,
      runId: run.runId,
      workflowName: run.name,
      occurrence: run.occurrence,
      parentSessionId: "session-1",
      generation: run.generation,
    }));
    const open = vi.fn(async (workspace: string) => ({ workspace, runtime: { workspace } }));
    Object.assign(mode, {
      links: {
        readSession: vi.fn(async () => ({ sessionId: "session-1", revision: 1, runs })),
        listLinks: vi.fn(async () => links),
      },
      runtimes: { open },
    });

    await expect(mode.resolveTask("session-1"))
      .resolves.toMatchObject({ runId: "run-3", workspace: "/three" });
    await expect(mode.resolveTask("session-1", { name: "review", occurrence: 1 }))
      .resolves.toMatchObject({ runId: "run-1", workspace: "/one" });
    await expect(mode.resolveTask("session-1", { name: "audit", occurrence: 1 }))
      .resolves.toMatchObject({ runId: "run-3", workspace: "/three" });
    expect(open).toHaveBeenCalledWith("/one");
    expect(open).toHaveBeenCalledWith("/three");
  });

  it("does not control an unavailable generation", async () => {
    const control = vi.fn();
    const mode = modeStub({
      prepare: { status: "rejected", reason: "task-unavailable" },
      control,
    });

    await expect(mode.cancelSessionTask({ sessionId: "session-1", generation: 1 }))
      .resolves.toMatchObject({ status: "rejected", reason: "task-unavailable" });
    expect(control).not.toHaveBeenCalled();
  });

  it("uses the durable request id, reconciles projection, and schedules attention", async () => {
    const control = vi.fn(async () => ({ isErr: () => false }));
    const settleCancel = vi.fn(async () => undefined);
    const reconcileRun = vi.fn(async () => undefined);
    const scheduleNoticeDelivery = vi.fn();
    const mode = modeStub({ control, settleCancel, reconcileRun, scheduleNoticeDelivery });

    await expect(mode.cancelSessionTask({ sessionId: "session-1", generation: 1 }))
      .resolves.toMatchObject({
        status: "applied",
        projection: { sessionId: "session-1", revision: 2 },
      });
    expect(control).toHaveBeenCalledWith({
      type: "cancel",
      runId: "private-run",
      requestId: "durable-request",
    });
    expect(settleCancel).toHaveBeenCalledWith({
      controlId: "control-1",
      outcome: "applied",
      taskStatus: "canceled",
    });
    expect(reconcileRun).toHaveBeenCalledOnce();
    expect(scheduleNoticeDelivery).toHaveBeenCalledWith("session-1");
  });
});

function modeStub(overrides: {
  prepare?: unknown;
  control?: ReturnType<typeof vi.fn>;
  settleCancel?: ReturnType<typeof vi.fn>;
  reconcileRun?: ReturnType<typeof vi.fn>;
  scheduleNoticeDelivery?: ReturnType<typeof vi.fn>;
}): AcpusMode {
  const link = {
    workspace: "/workspace",
    admissionRequestId: "admission-1",
    runId: "private-run",
    parentSessionId: "session-1",
    generation: 1,
    workflowName: "review",
    occurrence: 1,
  };
  const prepared = overrides.prepare ?? {
    status: "ready",
    control: {
      id: "control-1",
      requestId: "durable-request",
      actor: "user",
      parentSessionId: "session-1",
      generation: 1,
      workspace: "/workspace",
      runId: "private-run",
      status: "pending",
    },
    link,
  };
  const mode = Object.create(AcpusMode.prototype) as AcpusMode;
  Object.assign(mode, {
    links: {
      listLinks: vi.fn(async () => [link]),
      prepareCancel: vi.fn(async () => prepared),
      settleCancel: overrides.settleCancel ?? vi.fn(async () => undefined),
    },
    runtimes: {
      open: vi.fn(async () => ({
        workspace: "/workspace",
        runtime: { control: overrides.control ?? vi.fn() },
      })),
    },
    supervision: {
      reconcileRun: overrides.reconcileRun ?? vi.fn(async () => undefined),
      scheduleNoticeDelivery: overrides.scheduleNoticeDelivery ?? vi.fn(),
    },
    projections: {
      readSessionActivity: vi.fn(async () => ({
        sessionId: "session-1",
        revision: 2,
        tasks: [],
        tasksTruncated: false,
      })),
    },
  });
  return mode;
}
