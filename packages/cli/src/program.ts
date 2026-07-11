import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { createDoctorCommand } from "./commands/doctor.js";
import { createHooksCommand } from "./commands/hooks.js";
import { createRunsCommand } from "./commands/runs.js";
import { createSkillCommand } from "./commands/skill.js";
import { createVersionCommand, getCliPackageInfo } from "./commands/version.js";
import { createWebCommand } from "./commands/web.js";
import { createWorkflowCommand } from "./commands/workflow.js";
import { CliError, usageError } from "./errors.js";
import { writeResult } from "./output.js";

export type CliIo = {
  cwd: string;
  stdin?: Readable;
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
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return error.exitCode;
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
  const stdin = io.stdin ?? process.stdin;
  const program = new Command()
    .name("acpus")
    .description("Acpus TypeScript workflow CLI.")
    .version(getCliPackageInfo().version)
    .option("--json", "emit structured JSON output")
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

  program.addCommand(createWorkflowCommand({
    ...io,
    wantsJson,
    setExitCode,
  }));
  program.addCommand(createRunsCommand({
    ...io,
    stdin,
    wantsJson,
    setExitCode,
  }));
  program.addCommand(createHooksCommand({
    ...io,
    wantsJson,
    setExitCode,
  }));
  program.addCommand(createDoctorCommand({
    ...io,
    wantsJson,
    setExitCode,
  }));
  program.addCommand(createSkillCommand({
    ...io,
    wantsJson,
    setExitCode,
  }));
  program.addCommand(createVersionCommand({
    stdout: io.stdout,
    setExitCode,
  }));
  program.addCommand(createWebCommand({
    ...io,
    wantsJson,
  }));

  configureCommandTree(program, io, wantsJson);

  return program;
}

function configureCommandTree(command: Command, io: CliIo, wantsJson: boolean): void {
  command.configureHelp({ showGlobalOptions: true });
  command.configureOutput({
    writeOut: text => io.stdout.write(text),
    writeErr: text => {
      if (!wantsJson) io.stderr.write(text);
    },
    outputError: (text, write) => write(text),
  });
  for (const child of command.commands) configureCommandTree(child, io, wantsJson);
}
