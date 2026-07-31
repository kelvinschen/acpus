import { Command } from "commander";

export type JsonOutputOptions = { json?: boolean };

export function withJsonOutput(command: Command): Command {
  return command.option("--json", "emit structured JSON output");
}

export function jsonOutputFor(options: JsonOutputOptions): boolean {
  return options.json === true;
}

export function selectedJsonOutput(command: Command): boolean {
  if (jsonOutputFor(command.opts<JsonOutputOptions>())) return true;
  return command.commands.some(child => selectedJsonOutput(child));
}
