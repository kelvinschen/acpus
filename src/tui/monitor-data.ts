import fs from "node:fs/promises";
import path from "node:path";
import { buildRunMonitorView, buildWorkUnitDetailView, type RunMonitorView, type WorkUnitDetailView } from "../projections/run-monitor.js";
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
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.json"), "utf8")));
  return {
    locator,
    view: await buildRunMonitorView(locator.cwd, spec, index)
  };
}

export async function loadWorkUnitDetail(locator: RunLocator, workUnitId: string): Promise<WorkUnitDetailView> {
  const index = await syncRun(locator.cwd, locator.runId, { startPending: false });
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.json"), "utf8")));
  return buildWorkUnitDetailView(locator.cwd, spec, index, workUnitId);
}
