import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import React from "react";
import { render } from "ink";
import { buildRunMonitorView, buildTaskDetailView } from "../projections/run-monitor.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";
import { printJson } from "./common.js";
import { resolveOptionalRunArg } from "./run-selection.js";

export function registerMonitor(program: Command): void {
  const monitor = program.command("monitor")
    .argument("[run]", "logical run id or run directory")
    .option("--json", "print JSON")
    .action(async (runArg: string | undefined, options: Command | { json?: boolean }) => {
      const json = optionJson(options);
      runArg = await resolveOptionalRunArg({ runArg, json, title: "Select a run to monitor" });
      if (!runArg) return;
      if (!json) {
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
    .argument("<task-id>", "Stage Task id")
    .option("--json", "print JSON")
    .action(async (runArg: string, taskId: string, options: Command | { json?: boolean }, command?: Command) => {
      if (!optionJson(command ?? options)) throw new Error("Usage: monitor detail <run> <task-id> --json");
      const { locator, spec, index } = await loadObservedRun(runArg);
      printJson(await buildTaskDetailView(locator.cwd, spec, index, taskId));
    });
}

function optionJson(options: Command | { json?: boolean }): boolean {
  if ("json" in options && typeof options.json === "boolean") return options.json;
  if ("getOptionValue" in options && typeof options.getOptionValue === "function" && options.getOptionValue("json")) return true;
  if ("opts" in options && typeof options.opts === "function") {
    const own = options.opts<{ json?: boolean }>();
    if (own.json) return true;
    if (options.parent?.opts<{ json?: boolean }>().json) return true;
  }
  return false;
}

async function loadObservedRun(runArg: string) {
  const locator = await resolveRunLocator(runArg);
  const index = await syncRun(locator.cwd, locator.runId, { startPending: false });
  const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.yaml"), "utf8")));
  return { locator, index, spec };
}
