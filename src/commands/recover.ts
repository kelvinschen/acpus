import type { Command } from "commander";
import { recoverDriver } from "../runtime/worker.js";
import { printJson } from "./common.js";

export function registerRecover(program: Command): void {
  program.command("recover")
    .argument("<run>", "logical run id or run directory")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { json?: boolean }) => {
      const recovered = await recoverDriver(runArg);
      const output = {
        ok: true,
        runId: recovered.runId,
        runDir: recovered.runDir,
        worker: recovered.worker,
        message: "Run worker recovered."
      };
      if (options.json) printJson(output);
      else {
        process.stdout.write(`${output.message}\n`);
        process.stdout.write(`runId=${output.runId}\n`);
        process.stdout.write(`runDir=${output.runDir}\n`);
        process.stdout.write(`worker=${output.worker.pid} status=${output.worker.status}\n`);
      }
    });
}
