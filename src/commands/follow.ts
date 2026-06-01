import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { runViewFromIndex } from "../projections/run-view.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";
import { printJson } from "./common.js";

export function registerFollow(program: Command): void {
  program.command("follow")
    .argument("<run>", "logical run id or run directory")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { json?: boolean }) => {
      const locator = await resolveRunLocator(runArg);
      const index = await syncRun(locator.cwd, locator.runId);
      const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(locator.runId, locator.cwd), "workflow.spec.json"), "utf8")));
      const view = await runViewFromIndex(locator.cwd, spec, index);
      if (options.json) printJson(view);
      else process.stdout.write(`run ${locator.runId} status=${view.status} workflow=${view.workflowName}${view.finalVerdict ? ` verdict=${view.finalVerdict}` : ""}\n`);
    });
}
