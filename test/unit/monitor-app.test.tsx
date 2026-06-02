import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MonitorApp } from "../../src/tui/monitor-app.js";
import type { RunMonitorView, WorkUnitDetailView } from "../../src/projections/run-monitor.js";
import type { MonitorSnapshot } from "../../src/tui/monitor-data.js";

describe("MonitorApp", () => {
  it("renders stages and work units without token or tool-call counts", () => {
    const { lastFrame } = render(<MonitorApp runArg="run-1" initialView={monitorView()} initialLocator={{ cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }} pollMs={60_000} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("monitor-workflow");
    expect(frame).toContain("Stages");
    expect(frame).toContain("task");
    expect(frame).toContain("gpt-test");
    expect(frame).not.toMatch(/tok|tools/i);
  });

  it("uses the first loaded snapshot to select the active stage", async () => {
    const { lastFrame, unmount } = render(<MonitorApp runArg="run-1" pollMs={60_000} loadSnapshot={async () => snapshot(monitorView({
      stages: [
        stage("plan", "completed"),
        stage("review", "running")
      ],
      workUnits: [
        workUnit("stage:plan", "plan", "plan"),
        workUnit("stage:review", "review", "review")
      ]
    }))} />);
    await flushPromises();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("  [x] plan 1/1");
    expect(frame).toContain("> [>] review 0/1");
    expect(frame).toContain("review - 1 agents");
    unmount();
  });

  it("ignores stale monitor snapshots that resolve after a newer refresh", async () => {
    const first = deferred<MonitorSnapshot>();
    const second = deferred<MonitorSnapshot>();
    let calls = 0;
    const { frames, stdin, unmount } = render(<MonitorApp
      runArg="run-1"
      pollMs={60_000}
      loadSnapshot={async () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }}
    />);

    stdin.write("r");
    second.resolve(snapshot(monitorView({ workflowName: "newer-workflow" })));
    await flushPromises();
    first.resolve(snapshot(monitorView({ workflowName: "older-workflow" })));
    await flushPromises();

    const frame = frames.join("\n");
    expect(frame).toContain("newer-workflow");
    expect(frame).not.toContain("older-workflow");
    unmount();
  });

  it("ignores stale work-unit details after selection changes", async () => {
    const first = deferred<WorkUnitDetailView>();
    const second = deferred<WorkUnitDetailView>();
    let calls = 0;
    const initial = monitorView({
      workUnits: [
        workUnit("stage:task-a", "task", "task-a")
      ]
    });
    const refreshed = monitorView({
      workUnits: [
        workUnit("stage:task-b", "task", "task-b")
      ]
    });
    const { frames, stdin, unmount } = render(<MonitorApp
      runArg="run-1"
      initialView={initial}
      initialLocator={{ cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }}
      initialFocus="detail"
      pollMs={60_000}
      loadSnapshot={async () => snapshot(refreshed)}
      loadDetail={async (_locator, workUnitId) => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }}
    />);

    stdin.write("r");
    await flushPromises();
    second.resolve(detail(refreshed, "stage:task-b", "current detail"));
    await flushPromises();
    first.resolve(detail(initial, "stage:task-a", "stale detail"));
    await flushPromises();

    const frame = frames.join("\n");
    expect(frame).toContain("current detail");
    expect(frame).not.toContain("stale detail");
    unmount();
  });
});

function monitorView(overrides: Partial<RunMonitorView> & { workflowName?: string } = {}): RunMonitorView {
  const stages = overrides.stages ?? [stage("task", "running")];
  const workUnits = overrides.workUnits ?? [workUnit("stage:task", "task", "task")];
  return {
    version: "acpx-workflow-orchestrator.monitor/v1",
    generatedAt: "2026-06-02T00:00:00.000Z",
    run: {
      logicalRunId: "run-1",
      workflowName: overrides.workflowName ?? "monitor-workflow",
      status: "running",
      runDir: "/tmp/run-1",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:01.000Z"
    },
    stages,
    workUnits,
    progress: { knownWorkUnits: 1, completedWorkUnits: 0, estimatedWorkUnits: 1 }
  };
}

function stage(id: string, status: RunMonitorView["stages"][number]["status"]): RunMonitorView["stages"][number] {
  return {
    id,
    kind: "agentTask",
    status,
    dependsOn: [],
    workUnitCounts: {
      total: 1,
      pending: status === "pending" ? 1 : 0,
      running: status === "running" ? 1 : 0,
      completed: status === "completed" ? 1 : 0,
      blocked: status === "blocked" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
      skipped: status === "skipped" ? 1 : 0
    }
  };
}

function workUnit(id: string, stageId: string, label: string): RunMonitorView["workUnits"][number] {
  return {
    id,
    kind: "stage",
    stageId,
    label,
    status: "running",
    agent: "gpt-test",
    attemptIds: [`${label}:attempt-1`]
  };
}

function snapshot(view: RunMonitorView): MonitorSnapshot {
  return { locator: { cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }, view };
}

function detail(view: RunMonitorView, workUnitId: string, summary: string): WorkUnitDetailView {
  const workUnit = view.workUnits.find((unit) => unit.id === workUnitId);
  if (!workUnit) throw new Error(`Missing test work unit ${workUnitId}`);
  return {
    version: "acpx-workflow-orchestrator.work-unit-detail/v1",
    generatedAt: "2026-06-02T00:00:00.000Z",
    run: view.run,
    workUnit,
    outcome: { status: "completed", summary, artifacts: [] },
    activity: { totalAttempts: 0, attempts: [] }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
