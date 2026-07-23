import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { createDoctorCommand } from "./commands/doctor.js";
import { createHooksCommand } from "./commands/hooks.js";
import { selectedOutputFormat } from "./commands/output-option.js";
import { createRunsCommand } from "./commands/runs.js";
import { createSkillCommand } from "./commands/skill.js";
import { createWebCommand } from "./commands/web.js";
import { createWorkflowCommand } from "./commands/workflow.js";
import { CliError, usageError } from "./errors.js";
import { writeResult } from "./output.js";
import { getCliPackageInfo } from "./package-info.js";
import { createUpdateAwareness } from "./update-awareness.js";

export type CliIo = {
  cwd: string;
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const awareness = createUpdateAwareness({ argv, ...io });
  const program = createProgram(io, code => {
    exitCode = code;
  }, command => awareness.start(command));

  try {
    await program.parseAsync(argv, { from: "user" });
    await awareness.finish(exitCode);
    return exitCode;
  } catch (error) {
    const format = selectedOutputFormat(program);
    if (error instanceof CliError) {
      return writeResult(error.result, format, io, error.exitCode);
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") return error.exitCode;
      if (format === "json") {
        const result = usageError(error.message).result;
        return writeResult(result, "json", io, 2);
      }
      return 2;
    }
    throw error;
  }
}

function createProgram(
  io: CliIo,
  setExitCode: (code: number) => void,
  startUpdateAwareness: (command: Command) => void,
): Command {
  const stdin = io.stdin ?? process.stdin;
  const packageInfo = getCliPackageInfo();
  const program = new Command()
    .name("acpus")
    .description("Acpus TypeScript workflow CLI.")
    .option("-V, --version", "output the version number")
    .enablePositionalOptions()
    .exitOverride()
    .helpCommand(false)
    .showHelpAfterError()
    .action((options: { version?: boolean }) => {
      if (options.version) io.stdout.write(`${packageInfo.version}\n`);
      else program.outputHelp();
    });
  program.hook("preSubcommand", command => {
    if (command.opts<{ version?: boolean }>().version === true) {
      throw usageError("--version cannot be combined with a command.");
    }
  });
  program.hook("preAction", (_program, command) => {
    startUpdateAwareness(command);
  });

  program.addCommand(createWorkflowCommand({
    ...io,
    stdin,
    setExitCode,
  }));
  program.addCommand(createRunsCommand({
    ...io,
    stdin,
    setExitCode,
  }));
  program.addCommand(createHooksCommand({
    ...io,
    setExitCode,
  }));
  program.addCommand(createDoctorCommand({
    ...io,
    setExitCode,
  }));
  program.addCommand(createSkillCommand({
    ...io,
    stdin,
    setExitCode,
  }));
  program.addCommand(createWebCommand({
    ...io,
  }));

  configureCommandTree(program, program, io);

  return program;
}

function configureCommandTree(command: Command, program: Command, io: CliIo): void {
  command.helpCommand(false);
  command.configureOutput({
    writeOut: text => io.stdout.write(text),
    writeErr: text => {
      if (selectedOutputFormat(program) === "text") io.stderr.write(text);
    },
    outputError: (text, write) => write(text),
  });
  for (const child of command.commands) configureCommandTree(child, program, io);
}
