import type { Writable } from "node:stream";
import { Command } from "commander";
import { runtimeUnavailableError } from "../errors.js";
import { writeResult, type OutputFormat } from "../output.js";
import { runPreflight } from "../preflight.js";

export type RunCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type RunCommandOptions = {
  dryRun?: boolean;
  json?: boolean;
};

export function createRunCommand(ctx: RunCommandContext): Command {
  return new Command("run")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Typecheck, compile, and validate a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path")
    .option("--dry-run", "run the pre-run gate without executing the workflow")
    .option("--json", "print a structured JSON result")
    .action(async (workflow: string, options: RunCommandOptions) => {
      const format: OutputFormat = options.json ? "json" : "text";
      if (!options.dryRun) throw runtimeUnavailableError();
      const result = await runPreflight({
        workflow,
        cwd: ctx.cwd,
      });
      ctx.setExitCode(writeResult(result, format, ctx, 0));
    });
}
