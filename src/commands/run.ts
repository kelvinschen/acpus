import type { Command } from "commander";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { readFinalOutput } from "../projections/final-output.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import { prepareRun } from "../runtime/run-workflow.js";
import { runWorkflowWorker, spawnBackgroundWorker, type WorkerProgressEvent } from "../runtime/worker.js";
import { resultFromIssues } from "../errors.js";
import { applyInputDefaults, validateWorkflowInput } from "../schema/input-validation.js";
import { loadAndLint, printIssues, printJson, readInputArg, resolveSpecArg } from "./common.js";

export function registerRun(program: Command): void {
  program.command("run")
    .argument("[spec]", "spec file path or workflow name")
    .option("--global", "resolve saved workflow from global directory")
    .option("--input <json-or-path>", "workflow input as a JSON object string or JSON file path")
    .option("--wait", "run in the foreground until the workflow reaches a terminal state")
    .option("--json", "print JSON")
    .action(async (specArg: string | undefined, options: { global?: boolean; input?: string; wait?: boolean; json?: boolean }) => {
      if (!specArg) {
        if (options.json) printJson(resultFromIssues("run", []));
        else process.stderr.write("Error: provide a spec file path or workflow name.\n");
        process.exitCode = 1;
        return;
      }
      const specPath = await resolveSpecArg({ spec: specArg, global: options.global });
      const { spec, result } = await loadAndLint(specPath);
      if (!spec || !result.ok) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
        return;
      }
      const input = applyInputDefaults(spec, options.input ? await readInputArg(options.input) : {});
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
      try {
        if (options.wait) {
          const finalIndex = await runWorkflowWorker(process.cwd(), prepared.logicalRunId, {
            reporter: waitReporter(options.json)
          });
          await emitTerminalSummary(options.json, prepared.logicalRunId, prepared.dir, finalIndex, spec);
          return;
        }
        const worker = await spawnBackgroundWorker(process.cwd(), prepared.logicalRunId);
        const output = {
          ok: true,
          logicalRunId: prepared.logicalRunId,
          runDir: prepared.dir,
          status: "running",
          worker,
          note: "Run started in a background worker."
        };
        if (options.json) printJson(output);
        else {
          process.stdout.write(`run started: ${prepared.logicalRunId}\n`);
          process.stdout.write(`status: running worker=${worker.pid}\n`);
          process.stdout.write(`${prepared.dir}\n`);
        }
      } catch (error) {
        await markKnownRunFatal(process.cwd(), prepared.logicalRunId, error);
        throw error;
      }
    });
}

function waitReporter(json: boolean | undefined) {
  return async (event: WorkerProgressEvent): Promise<void> => {
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    if (event.type === "worker_started") {
      process.stdout.write(`worker started pid=${event.pid} run=${event.runId}\n`);
    } else if (event.type === "run_progress") {
      const stages = event.changedStages.map((stage) => `${stage.id}=${stage.status}`).join(" ");
      process.stdout.write(`progress status=${event.status}${stages ? ` ${stages}` : ""}\n`);
    } else {
      process.stdout.write(`worker exited pid=${event.pid} status=${event.status} exit=${event.exitCode ?? ""}\n`);
    }
  };
}

async function emitTerminalSummary(json: boolean | undefined, runId: string, dir: string, index: RunIndex, spec: WorkflowSpec): Promise<void> {
  const summary = {
    type: "terminal_summary",
    ok: index.status !== "failed" && index.status !== "cancelled",
    logicalRunId: runId,
    runDir: dir,
    status: index.status,
    blockedReason: index.blockedReason,
    gateVerdict: index.gateVerdict,
    finalOutput: json ? await readFinalOutput(dir, spec) : undefined
  };
  if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stdout.write(`terminal status=${summary.status}${summary.gateVerdict ? ` verdict=${summary.gateVerdict}` : ""}\n`);
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
