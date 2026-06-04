import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { buildRunMonitorView, buildTaskDetailView, type RunMonitorView, type TaskDetailView } from "../projections/run-monitor.js";
import type { RunLocator } from "../run-index/locator.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";

export type MonitorSnapshot = {
  locator: RunLocator;
  view: RunMonitorView;
};

export async function loadMonitorSnapshot(runArg: string): Promise<MonitorSnapshot> {
  const locator = await resolveRunLocator(runArg);
  const index = await syncRun(locator.cwd, locator.runId, { startPending: false });
  const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.yaml"), "utf8")));
  return {
    locator,
    view: await buildRunMonitorView(locator.cwd, spec, index)
  };
}

export async function loadTaskDetail(locator: RunLocator, taskId: string): Promise<TaskDetailView> {
  const index = await syncRun(locator.cwd, locator.runId, { startPending: false });
  const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.yaml"), "utf8")));
  return buildTaskDetailView(locator.cwd, spec, index, taskId);
}
