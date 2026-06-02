import { describe, expect, it } from "vitest";
import { detailSummary, defaultStageIndex, shorten, statusMark, workUnitsForStage } from "../../src/tui/monitor-rendering.js";
import type { RunMonitorView, WorkUnitDetailView } from "../../src/projections/run-monitor.js";

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

  it("filters work units by selected stage and truncates text", () => {
    const view = monitorView();
    expect(workUnitsForStage(view, "task").map((unit) => unit.id)).toEqual(["stage:task"]);
    expect(shorten("abcdefgh", 5)).toBe("ab...");
    expect(statusMark("running")).toBe("[>]");
    expect(statusMark("completed")).toBe("[x]");
  });

  it("builds bounded detail summary without token or tool-call labels", () => {
    const detail: WorkUnitDetailView = {
      version: "acpx-workflow-orchestrator.work-unit-detail/v1",
      generatedAt: "2026-06-02T00:00:00.000Z",
      run: monitorView().run,
      workUnit: monitorView().workUnits[0]!,
      prompt: { preview: "Prompt preview", lines: 1 },
      activity: {
        totalAttempts: 1,
        attempts: [{ id: "task:attempt-1", kind: "attempt", status: "completed", path: "attempts/task/attempt-1" }]
      },
      outcome: {
        path: "outputs/task.json",
        status: "completed",
        summary: "Done.",
        artifacts: [{ kind: "file", path: "src/task.ts" }]
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
    kind: "agentTask",
    status,
    dependsOn: [],
    workUnitCounts: { total: 1, pending: 0, running: status === "running" ? 1 : 0, completed: status === "completed" ? 1 : 0, blocked: status === "blocked" ? 1 : 0, failed: 0, skipped: 0 }
  };
}

function monitorView(): RunMonitorView {
  return {
    version: "acpx-workflow-orchestrator.monitor/v1",
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
    workUnits: [{
      id: "stage:task",
      kind: "stage",
      stageId: "task",
      label: "task",
      status: "running",
      agent: "gpt-test",
      attemptIds: ["task:attempt-1"]
    }],
    progress: { knownWorkUnits: 1, completedWorkUnits: 0, estimatedWorkUnits: 1 }
  };
}
