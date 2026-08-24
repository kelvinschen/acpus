import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { AcpusMode } from "../src/host/mode.js";
import { run } from "./effect.js";

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
    const open = vi.fn((link: { workspace: string }) => Effect.succeed({
      workspace: link.workspace,
      runtime: { workspace: link.workspace },
    }));
    Object.assign(mode, {
      links: {
        readSession: vi.fn(() => Effect.succeed({ sessionId: "session-1", revision: 1, runs })),
        listLinks: vi.fn(() => Effect.succeed(links)),
      },
      supervision: { openLinkedRuntime: open },
    });

    await expect(mode.resolveTask("session-1"))
      .resolves.toMatchObject({ runId: "run-3", workspace: "/three" });
    await expect(mode.resolveTask("session-1", { name: "review", occurrence: 1 }))
      .resolves.toMatchObject({ runId: "run-1", workspace: "/one" });
    await expect(mode.resolveTask("session-1", { name: "audit", occurrence: 1 }))
      .resolves.toMatchObject({ runId: "run-3", workspace: "/three" });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/one" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/three" }));
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
    const control = vi.fn(() => Effect.succeed({}));
    const settleCancel = vi.fn(() => Effect.void);
    const reconcileRun = vi.fn(() => Effect.void);
    const scheduleNoticeDelivery = vi.fn(() => Effect.void);
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

  it("keeps an unavailable pending cancel while reconciling later controls", async () => {
    const mode = Object.create(AcpusMode.prototype) as AcpusMode;
    const links = [1, 2].map(generation => ({
      workspace: `/workspace-${generation}`,
      admissionRequestId: `admission-${generation}`,
      runId: `run-${generation}`,
      workflowName: `task-${generation}`,
      occurrence: 1,
      parentSessionId: "session-1",
      generation,
    }));
    const controls = links.map(link => ({
      id: `control-${link.generation}`,
      requestId: `request-${link.generation}`,
      actor: "model" as const,
      parentSessionId: link.parentSessionId,
      generation: link.generation,
      workspace: link.workspace,
      runId: link.runId,
      status: "pending" as const,
    }));
    const settleCancel = vi.fn(() => Effect.void);
    const reconcileRun = vi.fn(() => Effect.void);
    const scheduleNoticeDelivery = vi.fn(() => Effect.void);
    const runtimeControl = vi.fn(() => Effect.succeed({ type: "cancel", state: "applied", run: {} }));
    Object.assign(mode, {
      links: {
        pendingControls: vi.fn(() => Effect.succeed(controls)),
        listLinks: vi.fn(() => Effect.succeed(links)),
        readSession: vi.fn(() => Effect.succeed({ sessionId: "session-1", revision: 1, runs: [] })),
        settleCancel,
      },
      supervision: {
        whenReady: vi.fn(() => Effect.void),
        openLinkedRuntime: vi.fn((link: { generation: number; workspace: string }) =>
          link.generation === 1
            ? Effect.fail({
                type: "workspace-unavailable" as const,
                workspace: link.workspace,
                message: "missing",
              })
            : Effect.succeed({ workspace: link.workspace, runtime: { control: runtimeControl } })),
        reconcileRun,
        scheduleNoticeDelivery,
      },
    });

    await run((mode as unknown as { reconcilePendingCancels(): Effect.Effect<void, Error> })
      .reconcilePendingCancels());

    expect(settleCancel).toHaveBeenCalledTimes(1);
    expect(settleCancel).toHaveBeenCalledWith(expect.objectContaining({
      controlId: "control-2",
      outcome: "applied",
    }));
    expect(reconcileRun).toHaveBeenCalledWith(links[1]);
    expect(scheduleNoticeDelivery).toHaveBeenCalledWith();
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
      listLinks: vi.fn(() => Effect.succeed([link])),
      prepareCancel: vi.fn(() => Effect.succeed(prepared)),
      settleCancel: overrides.settleCancel ?? vi.fn(() => Effect.void),
    },
    runtimes: {
      open: vi.fn(async () => ({
        workspace: "/workspace",
        runtime: { control: overrides.control ?? vi.fn() },
      })),
    },
    supervision: {
      openLinkedRuntime: vi.fn(() => Effect.succeed({
        workspace: "/workspace",
        runtime: { control: overrides.control ?? vi.fn() },
      })),
      reconcileRun: overrides.reconcileRun ?? vi.fn(() => Effect.void),
      scheduleNoticeDelivery: overrides.scheduleNoticeDelivery ?? vi.fn(() => Effect.void),
    },
    projections: {
      readSessionActivity: vi.fn(() => Effect.succeed({
        sessionId: "session-1",
        revision: 2,
        tasks: [],
        tasksTruncated: false,
      })),
    },
  });
  return mode;
}
