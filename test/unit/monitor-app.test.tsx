import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MonitorApp } from "../../src/tui/monitor-app.js";
import type { RunMonitorView, TaskDetailView } from "../../src/projections/run-monitor.js";
import type { MonitorSnapshot } from "../../src/tui/monitor-data.js";

describe("MonitorApp", () => {
  it("renders the three monitor panels without token or tool-call counts", () => {
    const { lastFrame } = render(<MonitorApp runArg="run-1" initialView={monitorView()} initialLocator={{ cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }} pollMs={60_000} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("monitor-workflow");
    expect(frame).toContain("Stage List");
    expect(frame).toContain("Stage Info");
    expect(frame).toContain("Task Detail");
    expect(frame).toContain("Current: task");
    expect(frame).toContain("Finished: 0/1");
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
      tasks: [
        task("task:plan", "plan", "plan"),
        task("task:review", "review", "review")
      ]
    }))} />);
    await flushPromises();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Current: review");
    expect(frame).toContain("Finished: 1/2");
    expect(frame).toContain("✔ plan 1/1");
    expect(frame).toContain("▶ ● review 0/1");
    expect(frame).toContain("1 tasks");
    unmount();
  });

  it("shows the running stage as current even when the selected stage differs", async () => {
    const { lastFrame, stdin } = render(<MonitorApp
      runArg="run-1"
      initialView={monitorView({
        stages: [
          stage("plan", "completed"),
          stage("review", "running")
        ],
        tasks: [
          task("task:plan", "plan", "plan"),
          task("task:review", "review", "review")
        ]
      })}
      initialLocator={{ cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }}
      pollMs={60_000}
    />);

    stdin.write("\u001b[A");
    await flushPromises();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Current: review");
    expect(frame).toContain("✔ plan 1/1");
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

  it("loads detail for the selected task and ignores stale details after selection changes", async () => {
    const first = deferred<TaskDetailView>();
    const second = deferred<TaskDetailView>();
    let calls = 0;
    const initial = monitorView({
      tasks: [
        task("task:task-a", "task", "task-a"),
        task("task:task-b", "task", "task-b")
      ]
    });
    const { frames, stdin, unmount } = render(<MonitorApp
      runArg="run-1"
      initialView={initial}
      initialLocator={{ cwd: "/tmp", runId: "run-1", dir: "/tmp/run-1" }}
      pollMs={60_000}
      loadSnapshot={async () => snapshot(initial)}
      loadDetail={async (_locator, taskId) => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }}
    />);

    expect(frames.join("\n")).toContain("No task");
    expect(frames.join("\n")).toContain("selected");
    stdin.write("\u001b[C");
    await flushPromises();
    stdin.write("\u001b[B");
    await flushPromises();
    second.resolve(detail(initial, "task:task-b", "current detail"));
    await flushPromises();
    first.resolve(detail(initial, "task:task-a", "stale detail"));
    await flushPromises();

    const frame = frames.join("\n");
    expect(frame).toContain("current detail");
    expect(frame).not.toContain("stale detail");
    unmount();
  });
});

function monitorView(overrides: Partial<RunMonitorView> & { workflowName?: string } = {}): RunMonitorView {
  const stages = overrides.stages ?? [stage("task", "running")];
  const tasks = overrides.tasks ?? [task("task:task", "task", "task")];
  return {
    version: "acpus.monitor/v1",
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
    tasks,
    progress: { knownTasks: tasks.length, completedTasks: tasks.filter((candidate) => candidate.status === "completed").length }
  };
}

function stage(id: string, status: RunMonitorView["stages"][number]["status"]): RunMonitorView["stages"][number] {
  return {
    id,
    kind: "task",
    status,
    dependsOn: [],
    taskCounts: {
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

function task(id: string, stageId: string, label: string): RunMonitorView["tasks"][number] {
  return {
    id,
    kind: "stage",
    execution: "agent",
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

function detail(view: RunMonitorView, taskId: string, summary: string): TaskDetailView {
  const selectedTask = view.tasks.find((candidate) => candidate.id === taskId);
  if (!selectedTask) throw new Error(`Missing test task ${taskId}`);
  return {
    version: "acpus.task-detail/v1",
    generatedAt: "2026-06-02T00:00:00.000Z",
    run: view.run,
    task: selectedTask,
    outcome: { status: "completed", summary },
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
