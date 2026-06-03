import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { previewRunView } from "../projections/run-view.js";
import { loadAndLint, printIssues, printJson, resolveSpecArg } from "./common.js";

export function registerPlan(program: Command): void {
  program.command("plan")
    .argument("<spec>", "spec file path or saved workflow name (auto-detected)")
    .option("--global", "resolve saved workflow from global directory")
    .option("--quiet", "suppress plan preview, show only issues")
    .option("--json", "print JSON")
    .action(async (spec: string, options: { global?: boolean; quiet?: boolean; json?: boolean }) => {
      const specPath = await resolveSpecArg({ spec, global: options.global });
      const { spec: loaded, result } = await loadAndLint(specPath);
      if (!loaded) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
        return;
      }
      if (options.quiet) {
        if (options.json) printJson(result);
        else printIssues(result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const view = previewRunView(loaded, [...result.warnings, ...result.errors], {
        validate: `acpus plan ${specPath}`,
        run: `acpus run ${specPath}`
      });
      if (options.json) {
        printJson(view);
      } else {
        process.stdout.write(`Workflow: ${view.workflowName}\n`);
        process.stdout.write(`Status: ${view.status}\n`);
        process.stdout.write(`Planned agent calls: ${view.agentUsage.planned}\n`);
        for (const fanout of view.fanout) {
          process.stdout.write(`Fanout ${fanout.stageId}: up to ${fanout.estimatedWorkUnits} lane work unit(s) from ${fanout.maxItems} item(s)\n`);
        }
        process.stdout.write("Risks:\n");
        for (const risk of view.risks) process.stdout.write(`- ${risk}\n`);
        process.stdout.write("Stages:\n");
        for (const stage of view.stages) process.stdout.write(`- ${stage.id} (${stage.kind})\n`);
        process.stdout.write("Audit:\n");
        process.stdout.write("- Run snapshot: .acpus/runs/<logicalRunId>/\n");
        process.stdout.write("- Saved workflow snapshot: .acpus/workflows/<name>/ after explicit save\n");
        printIssues(result);
      }
      if (!result.ok) process.exitCode = 1;
    });
}
