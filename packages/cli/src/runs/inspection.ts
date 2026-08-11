import { Command } from "commander";
import {
  listRuns,
  readInspection,
  type InspectionError,
  type InspectionViewQuery,
} from "@acpus/runtime";
import { notFoundError, usageError } from "../presentation/errors.js";
import { canPrompt } from "../presentation/prompt.js";
import type { RunsCommandContext } from "./context.js";
import { followExitCode, followRun } from "./follow.js";
import { formatInspectionCandidates, formatInspectionView } from "./inspection-surface.js";
import { pickRunId } from "./picker.js";
import { runtimeReadFailureCode, runtimeReadFailureMessage } from "./runtime-read.js";

type InspectRunOptions = {
  target?: string;
  timeline?: boolean;
  forensics?: boolean;
  follow?: boolean;
  awaitDecision?: boolean;
};

export function createInspectionCommand(ctx: RunsCommandContext): Command {
  return new Command("inspect")
    .exitOverride()
    .description("Inspect durable run structure and status.")
    .argument("[run-id]", "run id")
    .option("--target <run-target>", "inspect one authored target or @occurrence reference")
    .option("--timeline", "show current activity and recent semantic history for the target")
    .option("--forensics", "show frozen definition, effective invocation, and accepted result")
    .option("--follow", "wait until the selected run or target becomes terminal; Ctrl-C detaches")
    .option("--await-decision", "wait until the next external decision boundary; Ctrl-C detaches")
    .action(async (runId: string | undefined, options: InspectRunOptions) => {
      await inspectRunCommand(ctx, runId, options);
    });
}

async function inspectRun(ctx: RunsCommandContext, runId: string, options: InspectRunOptions): Promise<void> {
  if (options.follow || options.awaitDecision) {
    const outcome = await followRun(ctx.cwd, inspectionViewQuery(runId, options), {
      until: options.follow ? "subject-terminal" : "decision-boundary",
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    });
    ctx.setExitCode(followExitCode(outcome));
    return;
  }

  const inspected = await readInspection(ctx.cwd, inspectionViewQuery(runId, options));
  if (inspected.isErr()) throw inspectionError(inspected.error);
  const document = inspected.value;
  if (document.kind === "archived-run") return renderArchivedRun(ctx, document.run);
  ctx.stdout.write(document.kind === "candidates"
    ? formatInspectionCandidates(document, options.forensics ? "forensics" : options.timeline ? "timeline" : "summary")
    : formatInspectionView(document));
  ctx.setExitCode(0);
}

async function inspectRunCommand(
  ctx: RunsCommandContext,
  runId: string | undefined,
  options: InspectRunOptions,
): Promise<void> {
  validateInspectOptions(options);
  if (runId !== undefined) {
    await inspectRun(ctx, runId, options);
    return;
  }
  if (!canPrompt(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const runs = await listRuns(ctx.cwd);
  if (runs.isErr()) throw notFoundError(runtimeReadFailureMessage(runs.error), {
    errorCode: runtimeReadFailureCode(runs.error),
  });
  if (runs.value.length === 0) throw notFoundError("No active runs found. Inspect archived runs by id.");

  const selectedRunId = await pickRunId(runs.value, ctx);
  if (selectedRunId === undefined) throw usageError("Run selection cancelled.");
  await inspectRun(ctx, selectedRunId, options);
}

function renderArchivedRun(
  ctx: RunsCommandContext,
  run: { id: string; name: string; status: string; createdAt: string; updatedAt: string },
): void {
  ctx.stdout.write([
    `Archived run ${run.id}`,
    `Name: ${run.name}`,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    "",
  ].join("\n"));
  ctx.setExitCode(0);
}

function inspectionViewQuery(runId: string, options: InspectRunOptions): InspectionViewQuery {
  if (options.target !== undefined || options.forensics) {
    return {
      kind: "target",
      runId,
      target: options.target ?? "root",
      detail: options.forensics ? "forensics" : options.timeline ? "timeline" : "summary",
    };
  }
  return { kind: "run", runId };
}

function inspectionError(
  error: InspectionError,
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  if (
    error.type === "runtime-store-repair-required"
    || error.type === "runtime-store-unsupported"
    || error.type === "runtime-store-unavailable"
  ) {
    return notFoundError(runtimeReadFailureMessage(error), {
      errorCode: runtimeReadFailureCode(error),
      inspectionError: error,
    });
  }
  const message = error.message;
  return notFoundError(message, {
    errorCode: error.type.replaceAll("-", "_").toUpperCase(),
    inspectionError: error,
  });
}

function validateInspectOptions(options: InspectRunOptions): void {
  if (options.target !== undefined && options.target.trim().length === 0) {
    throw usageError("--target must be a non-empty string.");
  }
  if (options.timeline && options.forensics) throw usageError("--timeline and --forensics are mutually exclusive.");
  if (options.timeline && options.target === undefined) throw usageError("--timeline requires --target.");
  if (options.follow && options.awaitDecision) throw usageError("--follow and --await-decision are mutually exclusive.");
  if (options.forensics && (options.follow || options.awaitDecision)) {
    throw usageError("--forensics cannot be used with --follow or --await-decision.");
  }
}
