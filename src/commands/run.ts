import type { Command } from "commander";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import { prepareRun } from "../runtime/run-workflow.js";
import { runWorkflowWorker, spawnBackgroundWorker, type WorkerProgressEvent } from "../runtime/worker.js";
import { resultFromIssues } from "../errors.js";
import { applyInputDefaults, validateWorkflowInput } from "../schema/input-validation.js";
import { loadAndLint, printIssues, printJson, readJsonFile, resolveSpecPath } from "./common.js";

export function registerRun(program: Command): void {
  program.command("run")
    .option("--spec <path>", "workflow spec path")
    .option("--workflow <name>", "saved workflow name")
    .option("--global", "resolve saved workflow from global directory")
    .option("--input-json <path>", "raw workflow input JSON file")
    .option("--wait", "run in the foreground until the workflow reaches a terminal state")
    .option("--json", "print JSON")
    .action(async (options: { spec?: string; workflow?: string; global?: boolean; inputJson?: string; wait?: boolean; json?: boolean }) => {
      const specPath = resolveSpecPath(options);
      const { spec, result } = await loadAndLint(specPath);
      if (!spec || !result.ok) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
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
      try {
        if (options.wait) {
          const finalIndex = await runWorkflowWorker(process.cwd(), prepared.logicalRunId, {
            reporter: waitReporter(options.json)
          });
          emitTerminalSummary(options.json, prepared.logicalRunId, prepared.dir, finalIndex);
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

function emitTerminalSummary(json: boolean | undefined, runId: string, dir: string, index: RunIndex): void {
  const summary = {
    type: "terminal_summary",
    ok: index.status !== "failed" && index.status !== "cancelled",
    logicalRunId: runId,
    runDir: dir,
    status: index.status,
    blockedReason: index.blockedReason,
    gateVerdict: index.gateVerdict
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
