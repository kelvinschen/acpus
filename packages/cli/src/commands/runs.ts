import { Command } from "commander";
import { createArtifactCommands } from "./runs/artifacts.js";
import { createControlCommands } from "./runs/controls.js";
import { createDeletionCommands } from "./runs/deletion.js";
import { createInspectionCommand } from "./runs/inspection.js";
import type { RunsCommandContext } from "./runs/context.js";

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
