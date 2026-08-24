import { Command } from "commander";
import { tryParseDurationMs } from "@acpus/core/ir";
import {
  deleteRun as deleteRuntimeRun,
  getRun,
  listRuns,
  pruneRuns as pruneRuntimeRuns,
  type PruneReport,
  type RuntimeReadFailure,
  type RunRecord,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { deleteError, usageError } from "../presentation/errors.js";
import { writeResult } from "../presentation/output.js";
import { canPrompt } from "../presentation/prompt.js";
import type { RunsCommandContext } from "./context.js";
import {
  confirmAction,
  confirmDelete,
  pickRunsToDelete,
  type DeleteRunChoice,
} from "./picker.js";
import { toRunRecord } from "./record.js";
import { runtimeReadFailureCode, runtimeReadFailureMessage } from "./runtime-read.js";

type PruneRunOptions = {
  olderThan?: string;
  allWorkspaces?: boolean;
  dryRun?: boolean;
  yes?: boolean;
};

export function createDeletionCommands(ctx: RunsCommandContext): Command[] {
  const deleteCommand = new Command("delete")
    .exitOverride()
    .description("Delete durable run state and run-local artifacts.")
    .argument("[run-id]", "run id")
    .action(async (runId: string | undefined) => {
      await deleteRunCommand(ctx, runId);
    });

  const prune = new Command("prune")
    .exitOverride()
    .description("Delete terminal runs selected by age.")
    .option("--older-than <duration>", "select runs older than a duration such as 30d")
    .option("--all-workspaces", "select runs from every known workspace")
    .option("--dry-run", "report selected runs without deleting them")
    .option("--yes", "skip the interactive confirmation")
    .action(async (options: PruneRunOptions) => {
      await pruneRunsCommand(ctx, options);
    });

  return [deleteCommand, prune];
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
    }, ctx, 0));
    return;
  }
  if (!canPrompt(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const choices = await deleteChoices(ctx);
  if (choices.length === 0) throw deleteError("No runs found.");
  if (!choices.some(choice => choice.disabled !== true)) throw deleteError("No deletable runs found.");

  const selection = await pickRunsToDelete(choices, ctx);
  if (selection === undefined) throw usageError("Run selection cancelled.");
  if (selection.runIds.length === 0) throw usageError("No runs selected.");

  const confirmed = await confirmDelete(selection.runIds.length, ctx);
  if (confirmed !== true) throw usageError("Run deletion cancelled.");

  const initialSkipped = selection.selectedAll
    ? choices.filter(choice => choice.disabled === true).map(choice => choice.run)
    : [];
  const { deletedRuns, skippedRuns } = await deleteManyRuns(ctx, selection.runIds, initialSkipped);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "delete",
    message: deletedRuns.length === 1 ? "Run deleted." : "Runs deleted.",
    deletedRuns,
    skippedRuns,
  }, ctx, 0));
}

async function deleteChoices(ctx: RunsCommandContext): Promise<DeleteRunChoice[]> {
  const listed = await Effect.runPromise(Effect.result(listRuns(ctx.cwd)));
  if (Result.isFailure(listed)) throw deleteRuntimeReadError(listed.failure);
  return await Promise.all(listed.success.map(async run => {
    const details = await Effect.runPromise(Effect.result(getRun(ctx.cwd, run.id)));
    if (Result.isFailure(details)) throw deleteRuntimeReadError(details.failure);
    const active = details.success?.execution.state === "active";
    return {
      run,
      ...(active ? { disabled: true, hint: "active" } : {}),
    };
  }));
}

async function deleteManyRuns(
  ctx: RunsCommandContext,
  runIds: string[],
  initialSkipped: RunRecord[] = [],
): Promise<{ deletedRuns: RunRecord[]; skippedRuns: RunRecord[] }> {
  const deletedRuns: RunRecord[] = [];
  const skippedRuns = [...initialSkipped];
  const skippedIds = new Set(skippedRuns.map(run => run.id));
  for (const id of runIds) {
    const deleted = await Effect.runPromise(Effect.result(deleteRuntimeRun(ctx.cwd, id)));
    if (Result.isFailure(deleted)) {
      const read = await Effect.runPromise(Effect.result(getRun(ctx.cwd, id)));
      if (Result.isFailure(read)) throw deleteRuntimeReadError(read.failure);
      if (read.success && !skippedIds.has(read.success.id)) {
        skippedRuns.push(toRunRecord(read.success));
        skippedIds.add(read.success.id);
      }
      continue;
    }
    if (deleted.success) deletedRuns.push(deleted.success);
  }
  return { deletedRuns, skippedRuns };
}

async function deleteOneRun(ctx: RunsCommandContext, runId: string): Promise<RunRecord> {
  const deleted = await Effect.runPromise(Effect.result(deleteRuntimeRun(ctx.cwd, runId)));
  if (Result.isFailure(deleted)) {
    const read = await Effect.runPromise(Effect.result(getRun(ctx.cwd, runId)));
    if (Result.isFailure(read)) throw deleteRuntimeReadError(read.failure);
    throw deleteError(deleted.failure.message, {
      errorCode: "RUN_ACTIVE",
      ...(read.success ? { run: toRunRecord(read.success) } : {}),
    });
  }
  if (!deleted.success) throw deleteError(`Run '${runId}' was not found.`);
  return deleted.success;
}

function deleteRuntimeReadError(error: RuntimeReadFailure): ReturnType<typeof deleteError> {
  return deleteError(runtimeReadFailureMessage(error), { errorCode: runtimeReadFailureCode(error) });
}

async function pruneRunsCommand(ctx: RunsCommandContext, options: PruneRunOptions): Promise<void> {
  const olderThanMs = parsePruneAge(options.olderThan);
  const selectionCutoff = new Date(Date.now() - (olderThanMs ?? 0)).toISOString();
  const request = {
    ...(olderThanMs === undefined ? {} : { olderThanMs }),
    allWorkspaces: options.allWorkspaces ?? false,
    selectionCutoff,
  };
  if (!options.dryRun && !options.yes && !canPrompt(ctx)) {
    throw usageError("--yes is required to prune runs without an interactive terminal.");
  }
  const preview = await Effect.runPromise(pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: true }));
  const selectedItems = preview.selected.runs + preview.selected.archives;
  if (options.dryRun) {
    writePruneResult(ctx, preview, "Prune preview.");
    return;
  }
  if (selectedItems === 0 && preview.failures.length === 0 && !options.yes) {
    writePruneResult(ctx, preview, "No runs to prune.");
    return;
  }
  if (!options.yes) {
    writeResult({
      ok: preview.failures.length === 0,
      phase: "delete",
      message: "Prune preview.",
      prune: preview,
    }, ctx, preview.failures.length === 0 ? 0 : 1);
    const confirmed = preview.failures.length === 0
      ? await confirmDelete(selectedItems, ctx, "item")
      : await confirmAction(
          `Prune ${selectedItems} selected item${selectedItems === 1 ? "" : "s"} and retry ${preview.failures.length} unresolved workspace${preview.failures.length === 1 ? "" : "s"}?`,
          ctx,
        );
    if (confirmed !== true) throw usageError("Run pruning cancelled.");
  }

  const report = await Effect.runPromise(pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: false }));
  writePruneResult(ctx, report, report.failures.length === 0
    ? "Runs pruned."
    : "Run pruning completed with failures.");
}

function parsePruneAge(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = tryParseDurationMs(value);
  if (parsed._tag === "Failure") throw usageError("--older-than must be a duration such as 30d, 24h, or 15m.");
  return parsed.success;
}

function writePruneResult(ctx: RunsCommandContext, report: PruneReport, message: string): void {
  const exitCode = report.failures.length === 0 ? 0 : 1;
  ctx.setExitCode(writeResult({
    ok: exitCode === 0,
    phase: "delete",
    message,
    prune: report,
  }, ctx, exitCode));
}
