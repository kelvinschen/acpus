import { Command } from "commander";
import { createArtifactCommands } from "./artifacts.js";
import { createControlCommands } from "./controls.js";
import { createDeletionCommands } from "./deletion.js";
import { createInspectionCommand } from "./inspection.js";
import type { RunsCommandContext } from "./context.js";

export function createRunsCommand(ctx: RunsCommandContext): Command {
  const command = new Command("runs")
    .exitOverride()
    .description("Inspect and control durable runs.");

  command.addCommand(createInspectionCommand(ctx));
  for (const child of createArtifactCommands(ctx)) command.addCommand(child);
  for (const child of createDeletionCommands(ctx)) command.addCommand(child);
  for (const child of createControlCommands(ctx)) command.addCommand(child);
  return command;
}
