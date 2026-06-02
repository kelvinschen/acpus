import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunMonitorView, buildWorkUnitDetailView } from "../../src/projections/run-monitor.js";
import { runDir } from "../../src/run-index/paths.js";
import type { RunIndex } from "../../src/run-index/read-write.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

describe("RunMonitorView", () => {
  it("projects stages and known Agent Work Units without reading events", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "events.ndjson"), `${"x".repeat(128 * 1024)}\n`, "utf8");

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.version).toBe("acpx-workflow-orchestrator.monitor/v1");
    expect(view.run).toMatchObject({ logicalRunId: "monitor-run", workflowName: "monitor-workflow", status: "running" });
    expect(view).not.toHaveProperty("eventTail");
    expect(view.stages.find((stage) => stage.id === "review")?.workUnitCounts).toMatchObject({ total: 1, running: 1 });
    expect(view.workUnits.map((unit) => unit.id)).toEqual(expect.arrayContaining([
      "stage:task",
      "fanout:review:item:item-1:group:g:lane:a",
      "loop:quality_loop:round:1:stage:body",
      "loop:quality_loop:round:1:fanout:body_fanout:item:item-2:group:g:lane:a"
    ]));
    expect(view.workUnits.find((unit) => unit.id === "stage:task")).toMatchObject({
      status: "completed",
      roleName: "implementer",
      agent: "gpt-test",
      roleMode: "readOnly",
      attemptId: "task:attempt-1"
    });
  });

  it("returns bounded work-unit details from run-index attempts and output files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-detail-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "task.json"), `${JSON.stringify({
      status: "completed",
      summary: "Task completed.",
      artifacts: [{ kind: "file", path: "src/task.ts", label: "Task" }],
      data: { text: "x".repeat(4096) }
    }, null, 2)}\n`, "utf8");

    const detail = await buildWorkUnitDetailView(cwd, spec, index, "stage:task");

    expect(detail.version).toBe("acpx-workflow-orchestrator.work-unit-detail/v1");
    expect(detail.workUnit).toMatchObject({ id: "stage:task", status: "completed" });
    expect(detail.prompt).toMatchObject({ lines: 1, preview: "Implement task." });
    expect(detail.activity).toMatchObject({ totalAttempts: 1 });
    expect(detail.outcome).toMatchObject({
      status: "completed",
      summary: "Task completed.",
      artifacts: [{ kind: "file", path: "src/task.ts", label: "Task" }]
    });
    expect(detail.outcome?.preview?.length).toBeLessThanOrEqual(2100);
  });

  it("rejects unknown work-unit ids", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-missing-"));
    await expect(buildWorkUnitDetailView(cwd, monitorSpec(), monitorIndex(), "missing")).rejects.toThrow("Unknown work unit: missing");
  });
});

function monitorSpec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "monitor-workflow",
    root: "task",
    inputs: {
      items: { type: "array<json>", default: [] }
    },
    roles: {
      implementer: { category: "implementation", agent: "gpt-test", mode: "readOnly" },
      reviewer: { category: "review", agent: "gpt-review", mode: "readOnly" }
    },
    stages: [
      { id: "task", kind: "agentTask", role: "implementer", prompt: "Implement task." },
      {
        id: "review",
        kind: "fanout",
        dependsOn: ["task"],
        items: { source: "inputs.items" },
        laneGroups: [{ id: "g", mode: "all", lanes: [{ id: "a", role: "reviewer", prompt: "Review item." }] }]
      },
      {
        id: "quality_loop",
        kind: "loop",
        dependsOn: ["review"],
        maxRounds: 1,
        body: {
          root: "body",
          output: "body",
          stages: [
            { id: "body", kind: "agentTask", role: "implementer", prompt: "Review loop." },
            {
              id: "body_fanout",
              kind: "fanout",
              dependsOn: ["body"],
              items: { source: "inputs.items" },
              laneGroups: [{ id: "g", mode: "all", lanes: [{ id: "a", role: "reviewer", prompt: "Loop fanout." }] }]
            }
          ]
        },
        continueWhen: { source: "loop.current.output.status", op: "eq", value: "again" },
        onExhausted: "blocked"
      }
    ]
  });
}

function monitorIndex(): RunIndex {
  return {
    schemaVersion: "acpx-workflow-orchestrator.run/v2",
    logicalRunId: "monitor-run",
    workflowName: "monitor-workflow",
    status: "running",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:01:00.000Z",
    stages: {
      task: { stageId: "task", status: "completed", attempts: ["task:attempt-1"], outputPath: "outputs/task.json", startedAt: "2026-06-02T00:00:00.000Z", completedAt: "2026-06-02T00:00:10.000Z" },
      review: {
        stageId: "review",
        status: "running",
        attempts: [],
        fanout: {
          totalItems: 1,
          completedItems: 0,
          blockedItems: 0,
          allowPartial: false,
          workUnits: 1,
          items: [{
            id: "item-1",
            index: 0,
            status: "running",
            groups: [{ id: "g", mode: "all", status: "running", lanes: [{ id: "a", roleName: "reviewer", status: "running", attemptId: "review:item-1:g:a:attempt-1", outputPath: "outputs/review/item-1/g/a.json" }] }]
          }]
        }
      },
      quality_loop: {
        stageId: "quality_loop",
        status: "running",
        attempts: ["loop:round-1__stage-body:attempt-1"],
        loop: {
          maxRounds: 1,
          currentRound: 1,
          bodyOutputStageId: "body",
          rounds: [{
            round: 1,
            status: "running",
            bodyOutputStageId: "body",
            stages: {
              body: { stageId: "body", status: "completed", attempts: ["loop:round-1__stage-body:attempt-1"], outputPath: "outputs/quality_loop/round-1/body.json" },
              body_fanout: {
                stageId: "body_fanout",
                status: "running",
                attempts: [],
                fanout: {
                  totalItems: 1,
                  completedItems: 0,
                  blockedItems: 0,
                  allowPartial: false,
                  items: [{
                    id: "item-2",
                    index: 0,
                    status: "running",
                    groups: [{ id: "g", mode: "all", status: "running", lanes: [{ id: "a", roleName: "reviewer", status: "running", attemptId: "loop:round-1__stage-body_fanout__item-item-2:g:a:attempt-1", outputPath: "outputs/quality_loop/round-1/body_fanout/item-2/g/a.json" }] }]
                  }]
                }
              }
            }
          }]
        }
      }
    },
    attempts: {
      "task:attempt-1": { id: "task:attempt-1", stageId: "task", kind: "attempt", status: "completed", path: "attempts/task/attempt-1", startedAt: "2026-06-02T00:00:00.000Z", endedAt: "2026-06-02T00:00:10.000Z", promptPreview: "Implement task.", agent: "gpt-test", roleMode: "readOnly" },
      "review:item-1:g:a:attempt-1": { id: "review:item-1:g:a:attempt-1", stageId: "review", itemId: "item-1", groupId: "g", laneId: "a", kind: "attempt", status: "running", path: "attempts/review/item-item-1/group-g/lane-a/attempt-1", startedAt: "2026-06-02T00:00:20.000Z", promptPreview: "Review item.", agent: "gpt-review", roleMode: "readOnly" },
      "loop:round-1__stage-body:attempt-1": { id: "loop:round-1__stage-body:attempt-1", stageId: "quality_loop", itemId: "round-1__stage-body", kind: "attempt", status: "completed", path: "attempts/quality_loop/item-round-1__stage-body/attempt-1", startedAt: "2026-06-02T00:00:30.000Z", endedAt: "2026-06-02T00:00:40.000Z", promptPreview: "Review loop.", agent: "gpt-test", roleMode: "readOnly" },
      "loop:round-1__stage-body_fanout__item-item-2:g:a:attempt-1": { id: "loop:round-1__stage-body_fanout__item-item-2:g:a:attempt-1", stageId: "quality_loop", itemId: "round-1__stage-body_fanout__item-item-2", groupId: "g", laneId: "a", kind: "attempt", status: "running", path: "attempts/quality_loop/item-round-1__stage-body_fanout__item-item-2/group-g/lane-a/attempt-1", startedAt: "2026-06-02T00:00:50.000Z", promptPreview: "Loop fanout.", agent: "gpt-review", roleMode: "readOnly" }
    },
    agentUsage: { planned: 4, actual: 2, repairCalls: 0, recoveryCalls: 0 }
  };
}
