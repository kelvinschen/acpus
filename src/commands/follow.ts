import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { readRunIndex } from "../run-index/read-write.js";
import { syncRun } from "../runtime/sync.js";
import { terminalRunStatus, workerIsActive } from "../runtime/worker.js";
import { buildRunMonitorView } from "../projections/run-monitor.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";
import { printJson } from "./common.js";
import { resolveOptionalRunArg } from "./run-selection.js";

function printNdjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function registerFollow(program: Command): void {
  program.command("follow")
    .argument("[run]", "logical run id or run directory")
    .option("--json", "print JSON")
    .action(async (runArg: string | undefined, options: { json?: boolean }) => {
      runArg = await resolveOptionalRunArg({ runArg, json: options.json, title: "Select a run to follow" });
      if (!runArg) return;
      const locator = await resolveRunLocator(runArg);
      const index = await syncRun(locator.cwd, locator.runId, { startPending: false });

      const dir = runDir(locator.runId, locator.cwd);
      const eventsPath = path.join(dir, "events.ndjson");

      // If the run is already terminal, output and exit immediately.
      if (terminalRunStatus(index.status)) {
        if (options.json) {
          const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(dir, "workflow.spec.yaml"), "utf8")));
          printNdjson(await buildRunMonitorView(locator.cwd, spec, index));
        } else {
          process.stdout.write(`run ${locator.runId} ${index.status}\n`);
        }
        return;
      }

      // If the run is not terminal and has no active worker, output current state and exit.
      // There is nothing to follow if no worker will produce new events.
      if (!workerIsActive(index.worker)) {
        if (options.json) {
          const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(dir, "workflow.spec.yaml"), "utf8")));
          printNdjson(await buildRunMonitorView(locator.cwd, spec, index));
        } else {
          process.stdout.write(`run ${locator.runId} ${index.status} (no active worker)\n`);
        }
        return;
      }

      let linesRead = 0;
      let done = false;

      const onSigint = () => {
        done = true;
      };
      process.on("SIGINT", onSigint);

      // Read existing events
      linesRead = await readAndPrintNewEvents(eventsPath, linesRead, options.json ?? false);

      // Poll loop — streams in both text and JSON mode
      while (!done) {
        await sleep(500);
        linesRead = await readAndPrintNewEvents(eventsPath, linesRead, options.json ?? false);

        // Check terminal status
        try {
          const idx = await readRunIndex(locator.cwd, locator.runId);
          if (terminalRunStatus(idx.status)) {
            if (options.json) {
              const spec = WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(dir, "workflow.spec.yaml"), "utf8")));
              printNdjson(await buildRunMonitorView(locator.cwd, spec, idx));
            } else {
              process.stdout.write(`run ${locator.runId} ${idx.status}\n`);
            }
            done = true;
          }
        } catch {
          // run.json may not exist yet; keep polling
        }
      }

      process.removeListener("SIGINT", onSigint);
    });
}

async function readAndPrintNewEvents(eventsPath: string, linesRead: number, jsonMode: boolean): Promise<number> {
  let content: string;
  try {
    content = await fs.readFile(eventsPath, "utf8");
  } catch {
    return linesRead;
  }

  const lines = content.split("\n");
  // Last element from split on trailing newline is empty; ignore it
  const totalLines = content.endsWith("\n") ? lines.length - 1 : lines.length;

  for (let i = linesRead; i < totalLines; i++) {
    const line = lines[i];
    if (!line) continue;
    if (jsonMode) {
      process.stdout.write(`${line}\n`);
    } else {
      formatEvent(line);
    }
  }

  return totalLines;
}

function formatEvent(line: string): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }

  const type = typeof event.type === "string" ? event.type : "unknown";

  switch (type) {
    case "worker_started":
      process.stdout.write(`worker started pid=${event.pid ?? "?"} run=${event.runId ?? "?"}\n`);
      break;
    case "run_progress": {
      const changedStages = Array.isArray(event.changedStages) ? event.changedStages as Array<Record<string, unknown>> : [];
      const stageParts = changedStages.map((s) => `${s.id}=${s.status}`);
      process.stdout.write(`progress status=${event.status ?? "?"}${stageParts.length > 0 ? ` ${stageParts.join(" ")}` : ""}\n`);
      break;
    }
    case "worker_exited":
      process.stdout.write(`worker exited pid=${event.pid ?? "?"} status=${event.status ?? "?"}\n`);
      break;
    case "runtime_fatal":
      process.stdout.write(`fatal: ${event.message ?? String(event.error ?? "")}\n`);
      break;
    default:
      process.stdout.write(`event ${type}\n`);
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
