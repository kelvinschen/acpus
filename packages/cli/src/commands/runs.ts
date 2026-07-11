import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/expression/ir";
import { deleteRun as deleteRuntimeRun, getRun, getRunInspection, listRuns, normalizeForkInput, RuntimeUseCaseException, type PreparedRunWorkflow, type RunDetails, type RunInspectionError, type RunInspectionQuery, type RunRecord } from "@acpus/runtime";
import { controlError, deleteError, notFoundError, usageError, validationError } from "../errors.js";
import { writeResult, type OutputFormat } from "../output.js";
import { followRun, parseFollowInterval } from "../run-follow.js";
import { formatRunInspectionDocument } from "../run-inspection-surface.js";
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

type InspectRunOptions = {
  target?: string;
  all?: boolean;
  follow?: boolean;
  interval?: string;
  raw?: boolean;
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
    .description("Inspect durable run structure and status.")
    .argument("[run-id]", "run id")
    .option("--target <run-target>", "inspect one static node, dynamic node, frame, or attempt")
    .option("--all", "expand every dynamic run context")
    .option("--follow", "follow run status until completion or Ctrl-C")
    .option("--interval <duration>", "refresh followed status (default: 1s, minimum: 250ms)")
    .option("--raw", "emit the unbounded raw inspection bundle (requires --json)")
    .action(async (runId: string | undefined, options: InspectRunOptions) => {
      await inspectRunCommand(ctx, runId, options);
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

async function inspectRun(ctx: RunsCommandContext, runId: string, options: InspectRunOptions): Promise<void> {
  const query = inspectionQuery(runId, options);
  if (options.follow) {
    if (query.mode === "raw") throw usageError("--raw cannot be followed.");
    const outcome = await followRun(ctx.cwd, { ...query, intervalMs: parseFollowInterval(options.interval) }, {
      phase: "inspect",
      wantsJson: ctx.wantsJson,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    });
    ctx.setExitCode(outcome.kind === "error" ? 1 : 0);
    return;
  }

  const inspected = await getRunInspection(ctx.cwd, query);
  if (inspected.isErr()) throw inspectionError(inspected.error);
  if (ctx.wantsJson) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, phase: "inspect", ...inspected.value }, null, 2)}\n`);
  } else {
    ctx.stdout.write(formatRunInspectionDocument(inspected.value));
  }
  ctx.setExitCode(0);
}

async function inspectRunCommand(ctx: RunsCommandContext, runId: string | undefined, options: InspectRunOptions): Promise<void> {
  validateInspectOptions(ctx, options);
  if (runId !== undefined) {
    await inspectRun(ctx, runId, options);
    return;
  }
  if (ctx.wantsJson) throw usageError("Run id is required when --json is used.");
  if (!canPickRun(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const runs = await listRuns(ctx.cwd);
  if (runs.length === 0) throw notFoundError("No runs found.");

  const selectedRunId = await pickRunId(runs, ctx);
  if (selectedRunId === undefined) throw usageError("Run selection cancelled.");
  await inspectRun(ctx, selectedRunId, options);
}

function inspectionQuery(runId: string, options: InspectRunOptions): RunInspectionQuery {
  if (options.raw) return { runId, mode: "raw" };
  if (options.target !== undefined) return { runId, mode: "target", target: options.target };
  if (options.all) return { runId, mode: "all" };
  return { runId, mode: "overview" };
}

function inspectionError(error: RunInspectionError): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}

function validateInspectOptions(ctx: RunsCommandContext, options: InspectRunOptions): void {
  if (options.target === "") throw usageError("--target must be a non-empty string.");
  if (options.target !== undefined && options.all) throw usageError("--target cannot be used with --all.");
  if (options.interval !== undefined && !options.follow) throw usageError("--interval requires --follow.");
  if (options.raw && !ctx.wantsJson) throw usageError("--raw requires --json.");
  if (options.raw && (options.follow || options.all || options.target !== undefined)) {
    throw usageError("--raw cannot be used with --follow, --all, or --target.");
  }
  if (options.follow) void parseFollowInterval(options.interval);
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
    ...(terminalRun(result.run) ? {} : { followRunId: runId }),
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
    ...(result.forkRunId ? { followRunId: result.forkRunId } : terminalRun(result.run) ? {} : { followRunId: runId }),
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
    sourceGraphDigest: run.sourceGraphDigest,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progressVersion: run.progressVersion,
  };
}

function terminalRun(run: RunDetails): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "canceled";
}
