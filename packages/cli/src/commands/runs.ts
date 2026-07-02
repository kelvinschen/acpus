import type { Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/expression/ir";
import { applyRunControl, applySignalRunControl, getRun, listRuns, normalizeForkInput, type PreparedRunWorkflow, type RunDetails, type RunRecord } from "@acpus/runtime";
import { controlError, notFoundError, usageError, validationError } from "../errors.js";
import { writeResult, type OutputFormat } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { parseAgents, parseJsonOption, parseRequiredPayload } from "./json.js";
import { ensureSupervisorRunning } from "./supervisor.js";

export type RunsCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type RunsCommandOptions = {
  target?: string;
  payload?: string;
  input?: string;
  workflow?: string;
  agents?: string;
  limit?: string;
  all?: boolean;
};

type ControlAction = "pause" | "resume" | "retry" | "fork" | "cancel";

export function createRunsCommand(ctx: RunsCommandContext): Command {
  const command = new Command("runs")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Inspect and control durable runs.");

  command.addCommand(new Command("list")
    .exitOverride()
    .option("--limit <n>", "maximum number of recent runs to list")
    .option("--all", "list all runs")
    .action(async (options: RunsCommandOptions) => {
      await listRecentRuns(ctx, options);
    }));

  command.addCommand(new Command("inspect")
    .exitOverride()
    .argument("<run-id>", "run id")
    .action(async (runId: string) => {
      await inspectRun(ctx, runId);
    }));

  for (const name of ["pause", "resume", "retry", "cancel"] as const) {
    const control = new Command(name)
      .exitOverride()
      .argument("<run-id>", "run id")
      .action(async (runId: string, options: RunsCommandOptions) => {
        await mutateRun(ctx, runId, options, name);
      });
    if (name === "retry") control.option("--target <run-target>", "retry only a failed run target");
    if (name === "cancel") control.option("--target <run-target>", "cancel only a non-terminal run target");
    command.addCommand(control);
  }

  command.addCommand(new Command("fork")
    .exitOverride()
    .argument("<run-id>", "run id")
    .option("--workflow <workflow-module>", "use a replacement workflow module for the fork")
    .option("--input <json>", "override workflow input for the fork")
    .option("--agents <json>", "override inherited agents for the fork")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await mutateRun(ctx, runId, options, "fork");
    }));

  command.addCommand(new Command("signal")
    .exitOverride()
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "signal wait target")
    .requiredOption("--payload <json>", "signal payload JSON")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await signalRun(ctx, runId, options);
    }));

  return command;
}

async function listRecentRuns(ctx: RunsCommandContext, options: RunsCommandOptions): Promise<void> {
  if (options.all && options.limit !== undefined) throw usageError("--limit and --all are mutually exclusive.");
  const limit = options.all ? undefined : options.limit === undefined ? 20 : parseLimit(options.limit);
  const allRuns = await listRuns(ctx.cwd);
  const runs = limit === undefined ? allRuns : allRuns.slice(0, limit);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Runs listed.",
    runs,
    list: {
      total: allRuns.length,
      ...(limit === undefined ? {} : { limit }),
      truncated: limit !== undefined && allRuns.length > limit,
      order: "updatedAt DESC",
    },
  }, outputFormat(ctx), ctx, 0));
}

async function inspectRun(ctx: RunsCommandContext, runId: string): Promise<void> {
  const run = await getRun(ctx.cwd, runId);
  if (!run) throw notFoundError(`Run '${runId}' was not found.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Run inspected.",
    run,
  }, outputFormat(ctx), ctx, 0));
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  let result: Awaited<ReturnType<typeof applySignalRunControl>>;
  try {
    result = await applySignalRunControl(ctx.cwd, runId, options.target!, payload);
  } catch (error) {
    throw controlError(error instanceof Error ? error.message : String(error));
  }
  if (!result) throw controlError(`Run '${runId}' was not found.`);
  if (shouldWakeSupervisor(result.run)) ensureSupervisorRunning(ctx.cwd);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Signal accepted.",
    ...(result.command ? { command: result.command } : {}),
    run: runSummary(result.run),
  }, outputFormat(ctx), ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions, action: ControlAction): Promise<void> {
  const prepared = action === "fork" && options.workflow ? await prepareWorkflowForCli(options.workflow, ctx.cwd) : undefined;
  const agentOverrides = action === "fork" ? parseAgents(options.agents) : undefined;
  const forkInput = await maybeNormalizeForkInput(ctx, runId, action, options, prepared);
  let result: Awaited<ReturnType<typeof applyRunControl>>;
  try {
    result = await applyRunControl(ctx.cwd, runId, action, {
      ...(options.target ? { target: options.target } : {}),
      ...(prepared ? { prepared } : {}),
      ...(forkInput !== undefined ? { input: forkInput } : {}),
      ...(agentOverrides !== undefined ? { agentOverrides } : {}),
    });
  } catch (error) {
    throw controlError(error instanceof Error ? error.message : String(error));
  }
  if (!result) throw controlError(`Run '${runId}' was not found.`);
  if (shouldWakeSupervisor(result.run)) ensureSupervisorRunning(ctx.cwd);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: action === "fork" ? "Run forked." : action === "cancel" ? "Run canceled." : `Run ${action}d.`,
    ...(result.command ? { command: result.command } : {}),
    run: runSummary(result.run),
    ...(result.forkRunId ? { forkRunId: result.forkRunId } : {}),
  }, outputFormat(ctx), ctx, 0));
}

async function maybeNormalizeForkInput(
  ctx: RunsCommandContext,
  runId: string,
  action: ControlAction,
  options: RunsCommandOptions,
  prepared: PreparedRunWorkflow | undefined,
): Promise<JsonValue | undefined> {
  if (action !== "fork") return undefined;
  if (options.input === undefined && !prepared) return undefined;
  const rawInput = options.input === undefined ? undefined : parseJsonOption(options.input, "--input");
  try {
    return await normalizeForkInput(ctx.cwd, runId, rawInput, prepared);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error));
  }
}

function parseLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) throw usageError("--limit must be a positive integer.");
  return limit;
}

function outputFormat(ctx: RunsCommandContext): OutputFormat {
  return ctx.wantsJson ? "json" : "text";
}

function runSummary(run: RunDetails): RunRecord {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    workflowEntry: run.workflowEntry,
    irDigest: run.irDigest,
    sourceGraphDigest: run.sourceGraphDigest,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function shouldWakeSupervisor(run: RunDetails): boolean {
  return run.status === "pending" || run.status === "running";
}
