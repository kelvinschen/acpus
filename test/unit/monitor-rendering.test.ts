import { describe, expect, it } from "vitest";
import { detailSummary, defaultStageIndex, runStatusLabel, shorten, statusMark, tasksForStage } from "../../src/tui/monitor-rendering.js";
import type { RunMonitorView, TaskDetailView } from "../../src/projections/run-monitor.js";

describe("monitor TUI rendering helpers", () => {
  it("selects running, then blocked, then first non-completed stage", () => {
    expect(defaultStageIndex([
      stage("a", "completed"),
      stage("b", "running"),
      stage("c", "blocked")
    ])).toBe(1);
    expect(defaultStageIndex([
      stage("a", "completed"),
      stage("b", "blocked")
    ])).toBe(1);
    expect(defaultStageIndex([
      stage("a", "completed"),
      stage("b", "pending")
    ])).toBe(1);
  });

  it("filters tasks by selected stage and truncates text", () => {
    const view = monitorView();
    expect(tasksForStage(view, "task").map((task) => task.id)).toEqual(["task:task"]);
    expect(shorten("abcdefgh", 5)).toBe("ab...");
    expect(statusMark("running")).toBe("●");
    expect(statusMark("completed")).toBe("✔");
  });

  it("labels non-terminal runs with stale workers as stale for monitor display", () => {
    const view = monitorView();
    view.run.worker = {
      pid: 1234,
      generation: 1,
      status: "stale",
      startedAt: "2026-06-02T00:00:00.000Z",
      heartbeatAt: "2026-06-02T00:00:01.000Z",
      exitedAt: undefined,
      exitCode: undefined
    };

    expect(runStatusLabel(view)).toBe("stale");
  });

  it("builds bounded detail summary without token or tool-call labels", () => {
    const detail: TaskDetailView = {
      version: "acpus.task-detail/v1",
      generatedAt: "2026-06-02T00:00:00.000Z",
      run: monitorView().run,
      task: monitorView().tasks[0]!,
      prompt: { preview: "Prompt preview", lines: 1 },
      activity: {
        totalAttempts: 1,
        attempts: [{ id: "task:attempt-1", kind: "attempt", status: "completed", path: "attempts/task/attempt-1" }]
      },
      outcome: {
        path: "outputs/task.json",
        status: "completed",
        summary: "Done."
      }
    };
    const text = detailSummary(detail).join("\n");
    expect(text).toContain("Done.");
    expect(text).toContain("Prompt preview");
    expect(text).not.toMatch(/tok|tool/i);
  });
});

function stage(id: string, status: RunMonitorView["stages"][number]["status"]): RunMonitorView["stages"][number] {
  return {
    id,
    kind: "task",
    status,
    dependsOn: [],
    taskCounts: { total: 1, pending: 0, running: status === "running" ? 1 : 0, completed: status === "completed" ? 1 : 0, blocked: status === "blocked" ? 1 : 0, failed: 0, skipped: 0 }
  };
}

function monitorView(): RunMonitorView {
  return {
    version: "acpus.monitor/v1",
    generatedAt: "2026-06-02T00:00:00.000Z",
    run: {
      logicalRunId: "run-1",
      workflowName: "monitor-workflow",
      status: "running",
      runDir: "/tmp/run-1",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:01.000Z"
    },
    stages: [stage("task", "running")],
    tasks: [{
      id: "task:task",
      kind: "stage",
      execution: "agent",
      stageId: "task",
      label: "task",
      status: "running",
      agent: "gpt-test",
      attemptIds: ["task:attempt-1"]
    }],
    progress: { knownTasks: 1, completedTasks: 0 }
  };
}
