import type { Command } from "commander";
import { runWorkflowWorker } from "../runtime/worker.js";

export function registerRunWorker(program: Command): void {
  program.command("_run-worker", { hidden: true })
    .description("internal background workflow worker")
    .argument("<run>", "logical run id")
    .allowUnknownOption(false)
    .action(async (runId: string) => {
      await runWorkflowWorker(process.cwd(), runId);
    });
}
