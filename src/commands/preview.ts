import type { Command } from "commander";
import { previewRunView } from "../projections/run-view.js";
import { loadAndLint, printIssues, printJson, resolveSpecPath } from "./common.js";

export function registerPreview(program: Command): void {
  program.command("preview")
    .option("--spec <path>", "workflow spec path")
    .option("--workflow <name>", "saved workflow name")
    .option("--global", "resolve saved workflow from global directory")
    .option("--json", "print JSON")
    .action(async (options: { spec?: string; workflow?: string; global?: boolean; json?: boolean }) => {
      const specPath = resolveSpecPath(options);
      const { spec, result } = await loadAndLint(specPath);
      if (!spec) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
        return;
      }
      const view = previewRunView(spec, [...result.warnings, ...result.errors], {
        validate: `acpx-workflow-orchestrator validate --spec ${specPath}`,
        run: `acpx-workflow-orchestrator run --spec ${specPath} --yes`
      });
      if (options.json) printJson(view);
      else {
        process.stdout.write(`Workflow: ${view.workflowName}\n`);
        process.stdout.write(`Status: ${view.status}\n`);
        process.stdout.write(`Planned agent calls: ${view.agentUsage.planned}\n`);
        process.stdout.write("Risks:\n");
        for (const risk of view.risks) process.stdout.write(`- ${risk}\n`);
        process.stdout.write("Stages:\n");
        for (const stage of view.stages) process.stdout.write(`- ${stage.id} (${stage.kind})\n`);
        process.stdout.write("Audit:\n");
        process.stdout.write("- Run snapshot: .acpx-workflow-orchestrator/runs/<logicalRunId>/\n");
        process.stdout.write("- Saved workflow snapshot: .acpx-workflow-orchestrator/workflows/<name>/ after explicit save\n");
        printIssues(result);
      }
      if (!result.ok) process.exitCode = 1;
    });
}
