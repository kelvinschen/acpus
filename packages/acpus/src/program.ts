import type { Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { createRuntimeCommands } from "./commands/runtime.js";
import { createRunCommand } from "./commands/run.js";
import { createSupervisorCommand } from "./commands/supervisor.js";
import { CliError, usageError } from "./errors.js";
import { writeResult } from "./output.js";

export type CliIo = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const wantsJson = argv.includes("--json");
  const program = createProgram(io, code => {
    exitCode = code;
  }, wantsJson);

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CliError) {
      return writeResult(error.result, wantsJson ? "json" : "text", io, error.exitCode);
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") return error.exitCode;
      if (wantsJson) {
        const result = usageError(error.message).result;
        return writeResult(result, "json", io, 2);
      }
      return 2;
    }
    throw error;
  }
}

function createProgram(io: CliIo, setExitCode: (code: number) => void, wantsJson: boolean): Command {
  const program = new Command()
    .name("acpus")
    .description("Acpus TypeScript workflow CLI.")
    .exitOverride()
    .helpCommand(false)
    .showHelpAfterError()
    .configureOutput({
      writeOut: text => io.stdout.write(text),
      writeErr: text => {
        if (!wantsJson) io.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    });

  const context = {
    ...io,
    wantsJson,
    setExitCode,
  };
  program.addCommand(createRunCommand(context));
  for (const command of createRuntimeCommands(context)) program.addCommand(command);
  program.addCommand(createSupervisorCommand(context));

  return program;
}
