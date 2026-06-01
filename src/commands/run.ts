import type { Command } from "commander";
import { previewRunView, runViewFromIndex } from "../projections/run-view.js";
import { appendEvent, readRunIndex, writeRunIndex } from "../run-index/read-write.js";
import { prepareRun, startPreparedRun } from "../runtime/run-workflow.js";
import { syncRun } from "../runtime/sync.js";
import { resultFromIssues } from "../errors.js";
import { applyInputDefaults, validateWorkflowInput } from "../schema/input-validation.js";
import { loadAndLint, printIssues, printJson, readJsonFile, resolveSpecPath } from "./common.js";

export function registerRun(program: Command): void {
  program.command("run")
    .option("--spec <path>", "workflow spec path")
    .option("--workflow <name>", "saved workflow name")
    .option("--global", "resolve saved workflow from global directory")
    .option("--input-json <path>", "raw workflow input JSON file")
    .option("--yes", "skip approval after preview")
    .option("--wait", "advance scheduler until the workflow reaches a terminal state")
    .option("--prepare-only", "prepare the logical run without starting runtime turns")
    .option("--json", "print JSON")
    .action(async (options: { spec?: string; workflow?: string; global?: boolean; inputJson?: string; yes?: boolean; wait?: boolean; prepareOnly?: boolean; json?: boolean }) => {
      const specPath = resolveSpecPath(options);
      const { spec, result } = await loadAndLint(specPath);
      if (!spec || !result.ok) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
        return;
      }
      if (!options.yes) {
        const view = previewRunView(spec, result.warnings, {
          approve: `acpx-workflow-orchestrator run --spec ${specPath} --yes`
        });
        if (options.json) printJson({ ok: false, approvalRequired: true, preview: view });
        else {
          process.stdout.write("approval required; rerun with --yes after reviewing preview\n");
          process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
        }
        process.exitCode = 2;
        return;
      }
      const input = applyInputDefaults(spec, options.inputJson ? await readJsonFile(options.inputJson) : {});
      const inputResult = resultFromIssues("input", validateWorkflowInput(spec, input));
      if (!inputResult.ok) {
        if (options.json) printJson(inputResult);
        else printIssues(inputResult);
        process.exitCode = 1;
        return;
      }
      const prepared = await prepareRun(spec, {
        cwd: process.cwd(),
        input,
        sourcePath: specPath
      });
      let index;
      try {
        index = options.prepareOnly ? prepared.index : await startPreparedRun(process.cwd(), prepared, { drainFanoutPool: options.wait === true });
        if (!options.prepareOnly && options.wait) {
          index = await waitForLogicalRun(process.cwd(), prepared.logicalRunId);
        }
      } catch (error) {
        await markKnownRunFatal(process.cwd(), prepared.logicalRunId, error);
        throw error;
      }
      const runView = await runViewFromIndex(process.cwd(), spec, index);
      const output = {
        ok: true,
        logicalRunId: prepared.logicalRunId,
        runDir: prepared.dir,
        status: index.status,
        runView,
        note: options.prepareOnly ? "Run prepared without starting runtime turns." : "Run advanced."
      };
      if (options.json) printJson(output);
      else {
        process.stdout.write(`${options.prepareOnly ? "run prepared" : "run advanced"}: ${prepared.logicalRunId}\n`);
        process.stdout.write(`status: ${runView.status}${runView.gateVerdict ? ` verdict=${runView.gateVerdict}` : ""}\n`);
        process.stdout.write(`${prepared.dir}\n`);
      }
    });
}

async function waitForLogicalRun(cwd: string, runId: string) {
  while (true) {
    const index = await syncRun(cwd, runId, { drainFanoutPool: true });
    if (index.status !== "pending" && index.status !== "running") return index;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function markKnownRunFatal(cwd: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const index = await readRunIndex(cwd, runId);
    await writeRunIndex(cwd, {
      ...index,
      status: "failed",
      blockedReason: `RUNTIME_COMMAND_ERROR: ${message}`
    });
    await appendEvent(cwd, runId, {
      type: "runtime_fatal",
      code: "RUNTIME_COMMAND_ERROR",
      status: "failed",
      errorMessage: message,
      errorMetadata: error instanceof Error && "metadata" in error ? (error as { metadata?: unknown }).metadata : undefined
    });
  } catch {
    // Preserve the original CLI failure; best-effort terminal status only.
  }
}
