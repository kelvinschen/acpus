import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { createAgentCommand } from "./agent/command.js";
import { createDoctorCommand } from "./doctor/command.js";
import { createHooksCommand } from "./hooks/command.js";
import { getCliPackageInfo } from "./platform/package-info.js";
import { CliError, usageError } from "./presentation/errors.js";
import { writeResult } from "./presentation/output.js";
import { createRunsCommand } from "./runs/command.js";
import { createSkillCommand } from "./skill/command.js";
import { createUpdateAwareness } from "./update/awareness.js";
import { createWebCommand } from "./web/command.js";
import { createWorkflowCommand } from "./workflow/command.js";

export type CliIo = {
  cwd: string;
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const awareness = createUpdateAwareness({ argv, stdout: io.stdout, stderr: io.stderr });
  const program = createProgram(io, code => {
    exitCode = code;
  }, command => awareness.start(command));

  try {
    await program.parseAsync(argv, { from: "user" });
    await awareness.finish(exitCode);
    return exitCode;
  } catch (error) {
    if (error instanceof CliError) {
      return writeResult(error.result, io, error.exitCode);
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") return error.exitCode;
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
    .description([
      "Acpus TypeScript workflow CLI.",
      "",
      "If the Acpus Skill is not loaded, use acpus skill read to get its usage guide.",
    ].join("\n"))
    .option("-V, --version", "output the version number")
    .enablePositionalOptions()
    .exitOverride()
    .helpCommand(false)
    .showHelpAfterError()
    .action((options: { version?: boolean }) => {
      if (options.version) io.stdout.write(`${packageInfo.version}\n`);
      else program.outputHelp();
    });
  program.addHelpText("before", `Acpus ${packageInfo.version}\n`);
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
  program.addCommand(createAgentCommand({
    ...io,
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
    cwd: io.cwd,
    stdout: io.stdout,
    setExitCode,
  }));
  program.addCommand(createWebCommand({
    ...io,
  }));

  configureCommandTree(program, io);

  return program;
}

function configureCommandTree(command: Command, io: CliIo): void {
  command.helpCommand(false);
  command.configureOutput({
    writeOut: text => io.stdout.write(text),
    writeErr: text => io.stderr.write(text),
    outputError: (text, write) => write(text),
  });
  for (const child of command.commands) configureCommandTree(child, io);
}
