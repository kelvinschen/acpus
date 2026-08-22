import type { Writable } from "node:stream";
import { Command } from "commander";
import {
  addAgentPreset,
  loadAgentPresetCatalog,
  removeAgentPreset,
  type AgentPresetChoice,
  type AgentPresetSpec,
  type WritableAgentPresetScope,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { agentError, usageError } from "../presentation/errors.js";
import { parseJsonArgument } from "../presentation/json-input.js";

export type AgentCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type ScopeOptions = {
  project?: boolean;
  global?: boolean;
};

type AddOptions = ScopeOptions & {
  definition: string;
};

type AgentPresetChoiceView = Pick<AgentPresetChoice, "id" | "scope" | "guidance">;

export function createAgentCommand(ctx: AgentCommandContext): Command {
  const command = new Command("agent")
    .exitOverride()
    .description("Discover and configure reusable Agent bindings.");

  const presets = new Command("presets")
    .exitOverride()
    .description("List and manage Agent Presets. Running without a command lists Presets.")
    .option("--project", "list project Agent Presets")
    .option("--global", "list global Agent Presets")
    .action(async (options: ScopeOptions) => {
      await listAgentPresets(ctx, options);
    });

  presets.addCommand(new Command("add")
    .exitOverride()
    .description("Add one Agent Preset without overwriting an existing id.")
    .argument("<id>", "Agent Preset id")
    .requiredOption("--definition <json|file.json>", "complete inline JSON or JSON file Agent Preset definition")
    .option("--project", "add to the project Agent Preset catalog")
    .option("--global", "add to the global Agent Preset catalog")
    .action(async (id: string, _options: AddOptions, actionCommand: Command) => {
      await addAgentPresetFromCli(ctx, id, actionCommand.optsWithGlobals() as AddOptions);
    }));

  presets.addCommand(new Command("remove")
    .exitOverride()
    .description("Remove one Agent Preset from an explicit scope.")
    .argument("<id>", "Agent Preset id")
    .option("--project", "remove from the project Agent Preset catalog")
    .option("--global", "remove from the global Agent Preset catalog")
    .action(async (id: string, _options: ScopeOptions, actionCommand: Command) => {
      await removeAgentPresetFromCli(ctx, id, actionCommand.optsWithGlobals() as ScopeOptions);
    }));

  command.addCommand(presets);
  return command;
}

async function listAgentPresets(ctx: AgentCommandContext, options: ScopeOptions): Promise<void> {
  const scope = selectedScope(options);
  const catalog = await Effect.runPromise(Effect.result(loadAgentPresetCatalog({
    workspaceDir: ctx.cwd,
    ...(scope === undefined ? {} : { scopes: [scope] }),
  })));
  if (Result.isFailure(catalog)) throw agentError(catalog.failure.message);
  const choices = catalog.success.choices.map(choiceView);
  writeAgentPresetChoices(ctx.stdout, choices);
  ctx.setExitCode(0);
}

async function addAgentPresetFromCli(ctx: AgentCommandContext, id: string, options: AddOptions): Promise<void> {
  const scope = selectedScope(options, "add");
  const value = await parseJsonArgument(options.definition, ctx.cwd, "--definition");
  if (!isRecord(value)) throw usageError("--definition must be a JSON object.");
  const added = await Effect.runPromise(Effect.result(addAgentPreset({
    workspaceDir: ctx.cwd,
    scope,
    id,
    preset: value as AgentPresetSpec,
  })));
  if (Result.isFailure(added)) throw agentError(added.failure.message);
  ctx.stdout.write(`Agent Preset '${id}' added to ${scope} scope.\n`);
  ctx.setExitCode(0);
}

async function removeAgentPresetFromCli(ctx: AgentCommandContext, id: string, options: ScopeOptions): Promise<void> {
  const scope = selectedScope(options, "remove");
  const removed = await Effect.runPromise(Effect.result(
    removeAgentPreset({ workspaceDir: ctx.cwd, scope, id }),
  ));
  if (Result.isFailure(removed)) throw agentError(removed.failure.message);
  ctx.stdout.write(`Agent Preset '${id}' removed from ${scope} scope.\n`);
  ctx.setExitCode(0);
}

function selectedScope(options: ScopeOptions): WritableAgentPresetScope | undefined;
function selectedScope(options: ScopeOptions, operation: "add" | "remove"): WritableAgentPresetScope;
function selectedScope(options: ScopeOptions, operation?: "add" | "remove"): WritableAgentPresetScope | undefined {
  if (options.project && options.global) throw usageError("--project and --global are mutually exclusive.");
  if (options.project) return "project";
  if (options.global) return "global";
  if (operation !== undefined) throw usageError(`Agent Preset ${operation} requires exactly one of --project or --global.`);
  return undefined;
}

function choiceView(choice: AgentPresetChoice): AgentPresetChoiceView {
  return { id: choice.id, scope: choice.scope, guidance: choice.guidance };
}

function writeAgentPresetChoices(stream: Writable, choices: readonly AgentPresetChoiceView[]): void {
  if (choices.length === 0) {
    stream.write("No Agent Presets.\n");
    return;
  }
  let wroteScope = false;
  for (const scope of ["host", "project", "global"] as const) {
    const scopedChoices = choices.filter(choice => choice.scope === scope);
    if (scopedChoices.length === 0) continue;
    if (wroteScope) stream.write("\n");
    stream.write(`${scope[0]!.toUpperCase()}${scope.slice(1)} presets:\n`);
    const idWidth = scopedChoices.reduce((width, choice) => Math.max(width, choice.id.length), 0);
    for (const choice of scopedChoices) {
      stream.write(`  ${choice.id.padEnd(idWidth)}  ${choice.guidance}\n`);
    }
    wroteScope = true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
