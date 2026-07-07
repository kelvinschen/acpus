import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/expression/ir";
import { deleteRun as deleteRuntimeRun, getRun, getRunInspection, listRuns, normalizeForkInput, RuntimeUseCaseException, type PreparedRunWorkflow, type RunDetails, type RunRecord } from "@acpus/runtime";
import { controlError, deleteError, notFoundError, usageError, validationError } from "../errors.js";
import { writeResult, type OutputFormat } from "../output.js";
import { formatRunStatusSurface } from "../run-status-surface.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { parseAgents, parseJsonOption, parseRequiredPayload } from "./json.js";
import { canPickRun, confirmDelete, pickRunId, pickRunsToDelete, type DeleteRunChoice } from "./runs-picker.js";
import { DaemonControlFailure, daemonControlRequestId, sendDaemonControl } from "./daemon.js";

export type RunsCommandContext = {
  cwd: string;
  stdin: Readable;
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
  unsafeReuse?: boolean;
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

  command.addCommand(new Command("inspect")
    .exitOverride()
    .argument("[run-id]", "run id")
    .action(async (runId: string | undefined) => {
      await inspectRunCommand(ctx, runId);
    }));

  command.addCommand(new Command("delete")
    .exitOverride()
    .argument("[run-id]", "run id")
    .action(async (runId: string | undefined) => {
      await deleteRunCommand(ctx, runId);
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
    .option("--target <run-target>", "target a replacement workflow recovery point")
    .option("--unsafe-reuse", "dangerously reuse completed fork prerequisites despite workflow, input, or signature changes")
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

async function inspectRun(ctx: RunsCommandContext, runId: string): Promise<void> {
  if (!ctx.wantsJson) {
    const inspection = await getRunInspection(ctx.cwd, runId);
    if (!inspection) throw notFoundError(`Run '${runId}' was not found.`);
    ctx.stdout.write(formatRunStatusSurface(inspection.run, inspection.staticNodes));
    ctx.setExitCode(0);
    return;
  }
  const run = await getRun(ctx.cwd, runId);
  if (!run) throw notFoundError(`Run '${runId}' was not found.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Run inspected.",
    run,
  }, outputFormat(ctx), ctx, 0));
}

async function inspectRunCommand(ctx: RunsCommandContext, runId: string | undefined): Promise<void> {
  if (runId !== undefined) {
    await inspectRun(ctx, runId);
    return;
  }
  if (ctx.wantsJson) throw usageError("Run id is required when --json is used.");
  if (!canPickRun(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const runs = await listRuns(ctx.cwd);
  if (runs.length === 0) throw notFoundError("No runs found.");

  const selectedRunId = await pickRunId(runs, ctx);
  if (selectedRunId === undefined) throw usageError("Run selection cancelled.");
  await inspectRun(ctx, selectedRunId);
}

async function deleteRunCommand(ctx: RunsCommandContext, runId: string | undefined): Promise<void> {
  if (runId !== undefined) {
    const deleted = await deleteOneRun(ctx, runId);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "delete",
      message: "Run deleted.",
      run: deleted,
      deletedRuns: [deleted],
      skippedRuns: [],
    }, outputFormat(ctx), ctx, 0));
    return;
  }
  if (ctx.wantsJson) throw usageError("Run id is required when --json is used.");
  if (!canPickRun(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const choices = await deleteChoices(ctx);
  if (choices.length === 0) throw deleteError("No runs found.");
  if (!choices.some(choice => choice.disabled !== true)) throw deleteError("No deletable runs found.");

  const selection = await pickRunsToDelete(choices, ctx);
  if (selection === undefined) throw usageError("Run selection cancelled.");
  if (selection.runIds.length === 0) throw usageError("No runs selected.");

  const confirmed = await confirmDelete(selection.runIds.length, ctx);
  if (confirmed !== true) throw usageError("Run deletion cancelled.");

  const initialSkipped = selection.selectedAll ? choices.filter(choice => choice.disabled === true).map(choice => choice.run) : [];
  const { deletedRuns, skippedRuns } = await deleteManyRuns(ctx, selection.runIds, initialSkipped);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "delete",
    message: deletedRuns.length === 1 ? "Run deleted." : "Runs deleted.",
    deletedRuns,
    skippedRuns,
  }, outputFormat(ctx), ctx, 0));
}

async function deleteChoices(ctx: RunsCommandContext): Promise<DeleteRunChoice[]> {
  const runs = await listRuns(ctx.cwd);
  return await Promise.all(runs.map(async run => {
    const details = await getRun(ctx.cwd, run.id);
    const active = details?.execution.state === "active";
    return {
      run,
      ...(active ? { disabled: true, hint: "active" } : {}),
    };
  }));
}

async function deleteManyRuns(ctx: RunsCommandContext, runIds: string[], initialSkipped: RunRecord[] = []): Promise<{ deletedRuns: RunRecord[]; skippedRuns: RunRecord[] }> {
  const deletedRuns: RunRecord[] = [];
  const skippedRuns = [...initialSkipped];
  const skippedIds = new Set(skippedRuns.map(run => run.id));
  for (const id of runIds) {
    try {
      const deleted = await deleteRuntimeRun(ctx.cwd, id);
      if (!deleted) continue;
      deletedRuns.push(deleted);
    } catch (error) {
      if (error instanceof RuntimeUseCaseException && error.failure.type === "run-delete-active") {
        const run = await getRun(ctx.cwd, id);
        if (run && !skippedIds.has(run.id)) {
          skippedRuns.push(runSummary(run));
          skippedIds.add(run.id);
        }
        continue;
      }
      throw error;
    }
  }
  return { deletedRuns, skippedRuns };
}

async function deleteOneRun(ctx: RunsCommandContext, runId: string): Promise<RunRecord> {
  try {
    const deleted = await deleteRuntimeRun(ctx.cwd, runId);
    if (!deleted) throw deleteError(`Run '${runId}' was not found.`);
    return deleted;
  } catch (error) {
    if (error instanceof RuntimeUseCaseException && error.failure.type === "run-delete-active") {
      const run = await getRun(ctx.cwd, runId);
      throw deleteError(error.message, {
        errorCode: "RUN_ACTIVE",
        ...(run ? { run: runSummary(run) } : {}),
      });
    }
    throw error;
  }
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  let result: Awaited<ReturnType<typeof sendDaemonControl>>;
  try {
    result = await sendDaemonControl(ctx.cwd, { requestId: daemonControlRequestId(), type: "signal", runId, nodeId: options.target!, payload });
  } catch (error) {
    throw runControlError(error);
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Signal accepted.",
    run: runSummary(result.run),
  }, outputFormat(ctx), ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions, action: ControlAction): Promise<void> {
  if (action === "fork" && options.target === "") throw usageError("--target must be a non-empty string.");
  const prepared = action === "fork" && options.workflow ? await prepareWorkflowForCli(options.workflow, ctx.cwd) : undefined;
  const agentOverrides = action === "fork" ? parseAgents(options.agents) : undefined;
  const forkInput = await maybeNormalizeForkInput(ctx, runId, action, options, prepared);
  let result: Awaited<ReturnType<typeof sendDaemonControl>>;
  try {
    result = await sendDaemonControl(ctx.cwd, {
      requestId: daemonControlRequestId(),
      type: action,
      runId,
      input: {
      ...(options.target ? { target: options.target } : {}),
      ...(prepared ? { prepared } : {}),
      ...(forkInput !== undefined ? { input: forkInput } : {}),
      ...(agentOverrides !== undefined ? { agentOverrides } : {}),
      ...(action === "fork" && options.unsafeReuse === true ? { unsafeReuse: true } : {}),
      },
    });
  } catch (error) {
    throw runControlError(error);
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: action === "fork" ? "Run forked." : action === "cancel" ? "Run canceled." : `Run ${action}d.`,
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

function outputFormat(ctx: RunsCommandContext): OutputFormat {
  return ctx.wantsJson ? "json" : "text";
}

function runControlError(error: unknown): ReturnType<typeof controlError> {
  if (error instanceof DaemonControlFailure) {
    return controlError(error.message, {
      errorCode: error.code,
      control: { type: error.controlType, runId: error.runId },
      ...(error.run ? { run: runSummary(error.run) } : {}),
    });
  }
  return controlError(error instanceof Error ? error.message : String(error));
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
    progressVersion: run.progressVersion,
  };
}
