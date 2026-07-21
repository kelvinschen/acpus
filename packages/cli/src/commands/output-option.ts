import { Command } from "commander";
import type { OutputFormat } from "../output.js";

export type JsonOutputOptions = { json?: boolean };

export function withJsonOutput(command: Command): Command {
  return command.option("--json", "emit structured JSON output");
}

export function outputFormatFor(options: JsonOutputOptions): OutputFormat {
  return options.json === true ? "json" : "text";
}

export function selectedOutputFormat(command: Command): OutputFormat {
  if (outputFormatFor(command.opts<JsonOutputOptions>()) === "json") return "json";
  return command.commands.some(child => selectedOutputFormat(child) === "json") ? "json" : "text";
}
