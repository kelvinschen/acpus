import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { createDoctorCommand } from "./commands/doctor.js";
import { createHooksCommand } from "./commands/hooks.js";
import { createRunsCommand } from "./commands/runs.js";
import { createSkillCommand } from "./commands/skill.js";
import { createWebCommand } from "./commands/web.js";
import { createWorkflowsCommand } from "./commands/workflows.js";
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
  const normalizedArgv = argv.filter(arg => arg !== "--json");
  const program = createProgram(io, code => {
    exitCode = code;
  }, wantsJson);

  try {
    await program.parseAsync(normalizedArgv, { from: "user" });
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
  const stdin = io.stdin ?? process.stdin;
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

  program.addCommand(createWorkflowsCommand({
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
  program.addCommand(createWebCommand({
    ...io,
    wantsJson,
  }));

  return program;
}
