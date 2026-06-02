import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { buildRunMonitorView, buildWorkUnitDetailView } from "../projections/run-monitor.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";
import { printJson } from "./common.js";

export function registerMonitor(program: Command): void {
  const monitor = program.command("monitor")
    .argument("<run>", "logical run id or run directory")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: Command | { json?: boolean }) => {
      if (!optionJson(options)) {
        const { MonitorApp } = await import("../tui/monitor-app.js");
        const app = render(React.createElement(MonitorApp, { runArg }));
        await app.waitUntilExit();
        return;
      }
      const { locator, spec, index } = await loadObservedRun(runArg);
      printJson(await buildRunMonitorView(locator.cwd, spec, index));
    });

  monitor.command("detail")
    .argument("<run>", "logical run id or run directory")
    .argument("<work-unit-id>", "Agent Work Unit id")
    .option("--json", "print JSON")
    .action(async (runArg: string, workUnitId: string, options: Command | { json?: boolean }) => {
      if (!optionJson(options)) throw new Error("Usage: monitor detail <run> <work-unit-id> --json");
      const { locator, spec, index } = await loadObservedRun(runArg);
      printJson(await buildWorkUnitDetailView(locator.cwd, spec, index, workUnitId));
    });
}

function optionJson(options: Command | { json?: boolean }): boolean {
  if ("json" in options && typeof options.json === "boolean") return options.json;
  if ("opts" in options && typeof options.opts === "function") {
    const own = options.opts<{ json?: boolean }>();
    if (own.json) return true;
    if (options.getOptionValue?.("json")) return true;
    if (options.parent?.opts<{ json?: boolean }>().json) return true;
  }
  return process.argv.includes("--json");
}

async function loadObservedRun(runArg: string) {
  const locator = await resolveRunLocator(runArg);
  const index = await syncRun(locator.cwd, locator.runId, { startPending: false });
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.json"), "utf8")));
  return { locator, index, spec };
}
