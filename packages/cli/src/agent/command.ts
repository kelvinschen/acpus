import type { Writable } from "node:stream";
import { Command } from "commander";
import {
  AUTHORING_AGENT_SCALE_ENV,
  addAgentPreset,
  loadAcpusConfigScope,
  loadAgentAuthoringContext,
  loadAgentPresetCatalog,
  normalizeAuthoringAgentScale,
  removeAgentPreset,
  setAuthoringAgentScale,
  unsetAuthoringAgentScale,
  type AgentPresetChoice,
  type AgentPresetSpec,
  type WritableAgentPresetScope,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { agentError, usageError } from "../presentation/errors.js";
import { parseJsonArgument } from "../presentation/json-input.js";
import { formatAgentAuthoringContext, formatAuthoringAgentScale } from "./presentation.js";

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
    .description("Discover Agent authoring context and configure reusable Agent bindings.")
    .action(async () => {
      await showAgentAuthoringContext(ctx);
    });

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
  command.addCommand(createScaleCommand(ctx));
  return command;
}

function createScaleCommand(ctx: AgentCommandContext): Command {
  const scale = new Command("scale")
    .exitOverride()
    .description("Inspect or configure the Authoring Agent scale guideline.")
    .option("--project", "inspect the project scale")
    .option("--global", "inspect the global scale")
    .action(async (options: ScopeOptions) => {
      await showAuthoringAgentScale(ctx, options);
    });
  scale.addCommand(new Command("set")
    .exitOverride()
    .argument("<value>", "positive safe integer or small, medium, large, unrestricted")
    .option("--project", "set the project scale")
    .option("--global", "set the global scale")
    .action(async (value: string, _options: ScopeOptions, actionCommand: Command) => {
      await setScaleFromCli(ctx, value, actionCommand.optsWithGlobals() as ScopeOptions);
    }));
  scale.addCommand(new Command("unset")
    .exitOverride()
    .option("--project", "unset the project scale")
    .option("--global", "unset the global scale")
    .action(async (_options: ScopeOptions, actionCommand: Command) => {
      await unsetScaleFromCli(ctx, actionCommand.optsWithGlobals() as ScopeOptions);
    }));
  return scale;
}

async function showAgentAuthoringContext(ctx: AgentCommandContext): Promise<void> {
  const context = await Effect.runPromise(Effect.result(loadAgentAuthoringContext({ workspaceDir: ctx.cwd })));
  if (Result.isFailure(context)) throw agentError(context.failure.message);
  ctx.stdout.write(formatAgentAuthoringContext(context.success));
  ctx.setExitCode(0);
}

async function showAuthoringAgentScale(ctx: AgentCommandContext, options: ScopeOptions): Promise<void> {
  const scope = selectedScope(options);
  if (scope === undefined) {
    const context = await Effect.runPromise(Effect.result(loadAgentAuthoringContext({ workspaceDir: ctx.cwd })));
    if (Result.isFailure(context)) throw agentError(context.failure.message);
    ctx.stdout.write(`${formatAuthoringAgentScale(context.success.scale)}\n`);
  } else {
    const config = await Effect.runPromise(Effect.result(loadAcpusConfigScope({ workspaceDir: ctx.cwd, scope })));
    if (Result.isFailure(config)) throw agentError(config.failure.message);
    const value = config.success.authoring.agentScale;
    if (value === undefined) ctx.stdout.write(`Authoring Agent scale (${scope}): unconfigured\n`);
    else {
      const normalized = normalizeAuthoringAgentScale(value);
      if (Result.isFailure(normalized)) throw agentError(normalized.failure.message);
      ctx.stdout.write(`${formatAuthoringAgentScale({ ...normalized.success, source: scope })}\n`);
    }
  }
  ctx.setExitCode(0);
}

async function setScaleFromCli(ctx: AgentCommandContext, rawValue: string, options: ScopeOptions): Promise<void> {
  const scope = selectedScaleWriteScope(options, "set");
  const candidate: unknown = /^[1-9]\d*$/.test(rawValue) ? Number(rawValue) : rawValue;
  const normalized = normalizeAuthoringAgentScale(candidate);
  if (Result.isFailure(normalized)) throw usageError(normalized.failure.message);
  const written = await Effect.runPromise(Effect.result(setAuthoringAgentScale({
    workspaceDir: ctx.cwd,
    scope,
    value: normalized.success.value,
  })));
  if (Result.isFailure(written)) throw agentError(written.failure.message);
  ctx.stdout.write(`Authoring Agent scale set to '${rawValue}' in ${scope} scope.\n`);
  writeEnvironmentScaleWarning(ctx.stderr);
  ctx.setExitCode(0);
}

async function unsetScaleFromCli(ctx: AgentCommandContext, options: ScopeOptions): Promise<void> {
  const scope = selectedScaleWriteScope(options, "unset");
  const written = await Effect.runPromise(Effect.result(unsetAuthoringAgentScale({ workspaceDir: ctx.cwd, scope })));
  if (Result.isFailure(written)) throw agentError(written.failure.message);
  ctx.stdout.write(`Authoring Agent scale unset in ${scope} scope.\n`);
  writeEnvironmentScaleWarning(ctx.stderr);
  ctx.setExitCode(0);
}

function selectedScaleWriteScope(options: ScopeOptions, operation: "set" | "unset"): WritableAgentPresetScope {
  const scope = selectedScope(options);
  if (scope === undefined) throw usageError(`Authoring Agent scale ${operation} requires exactly one of --project or --global.`);
  return scope;
}

function writeEnvironmentScaleWarning(stream: Writable): void {
  const value = process.env[AUTHORING_AGENT_SCALE_ENV];
  if (value === undefined) return;
  const candidate: unknown = /^[1-9]\d*$/.test(value) ? Number(value) : value;
  const normalized = normalizeAuthoringAgentScale(candidate);
  stream.write(Result.isFailure(normalized)
    ? `Warning: ${AUTHORING_AGENT_SCALE_ENV} is invalid; effective authoring context remains unavailable until it is fixed.\n`
    : `Warning: ${AUTHORING_AGENT_SCALE_ENV} overrides configured scale in the effective authoring context.\n`);
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
