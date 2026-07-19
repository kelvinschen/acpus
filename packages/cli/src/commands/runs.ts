import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/expression/ir";
import { deleteRun as deleteRuntimeRun, getRun, getRunInspection, listArtifacts, listRuns, tryNormalizeForkInput, type ArtifactRecord, type DaemonControlIntent, type DaemonControlResult, type PreparedRunWorkflow, type RunDetails, type RunInspectionError, type RunInspectionQuery, type RunRecord } from "@acpus/runtime";
import { controlError, deleteError, notFoundError, usageError, validationError } from "../errors.js";
import { writeResult, type CliAppliedControl, type OutputFormat } from "../output.js";
import { followRun, parseFollowInterval } from "../run-follow.js";
import { formatRunInspectionDocument } from "../run-inspection-surface.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { parseAgents, parseInput, parseRequiredPayload } from "./json.js";
import { canPickRun, confirmDelete, pickRunId, pickRunsToDelete, type DeleteRunChoice } from "./runs-picker.js";
import { daemonControlRequestId, sendDaemonControl, type DaemonControlFailure } from "./daemon.js";
import { toRunRecord } from "../run-record.js";

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

type ArtifactsRunOptions = {
  target?: string;
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

  command.addCommand(new Command("artifacts")
    .exitOverride()
    .description("List artifact metadata and absolute paths.")
    .argument("<run-id>", "run id")
    .option("--target <run-target>", "list artifacts for one static node, dynamic node, frame, or attempt")
    .action(async (runId: string, options: ArtifactsRunOptions) => {
      await artifactsRunCommand(ctx, runId, options);
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
    .option("--input <json|file.json>", "override workflow input with inline JSON or a JSON file")
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

async function artifactsRunCommand(ctx: RunsCommandContext, runId: string, options: ArtifactsRunOptions): Promise<void> {
  if (options.target === "") throw usageError("--target must be a non-empty string.");
  let artifacts: ArtifactRecord[];
  if (options.target === undefined) {
    const listed = await listArtifacts(ctx.cwd, runId);
    if (listed === undefined) throw notFoundError(`Run '${runId}' was not found.`, { errorCode: "RUN_NOT_FOUND" });
    artifacts = listed;
  } else {
    const inspected = await getRunInspection(ctx.cwd, { runId, mode: "target", target: options.target });
    if (inspected.isErr()) throw inspectionError(inspected.error);
    if (inspected.value.kind !== "target") throw new Error("Target inspection returned an unexpected document.");
    artifacts = inspected.value.artifacts;
  }

  if (ctx.wantsJson) {
    ctx.stdout.write(`${JSON.stringify({
      ok: true,
      phase: "inspect",
      runId,
      ...(options.target === undefined ? {} : { target: options.target }),
      artifacts,
    }, null, 2)}\n`);
  } else if (artifacts.length === 0) {
    ctx.stdout.write("No artifacts.\n");
  } else {
    ctx.stdout.write(`${artifacts.map(artifact => `${artifact.id} ${artifact.mediaType ?? "-"} ${artifact.path}`).join("\n")}\n`);
  }
  ctx.setExitCode(0);
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
    const deleted = await deleteRuntimeRun(ctx.cwd, id);
    if (deleted.isErr()) {
      const run = await getRun(ctx.cwd, id);
      if (run && !skippedIds.has(run.id)) {
        skippedRuns.push(toRunRecord(run));
        skippedIds.add(run.id);
      }
      continue;
    }
    if (deleted.value) deletedRuns.push(deleted.value);
  }
  return { deletedRuns, skippedRuns };
}

async function deleteOneRun(ctx: RunsCommandContext, runId: string): Promise<RunRecord> {
  const deleted = await deleteRuntimeRun(ctx.cwd, runId);
  if (deleted.isErr()) {
    const run = await getRun(ctx.cwd, runId);
    throw deleteError(deleted.error.message, {
      errorCode: "RUN_ACTIVE",
      ...(run ? { run: toRunRecord(run) } : {}),
    });
  }
  if (!deleted.value) throw deleteError(`Run '${runId}' was not found.`);
  return deleted.value;
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  const controlled = await sendDaemonControl(ctx.cwd, { requestId: daemonControlRequestId(), type: "signal", runId, nodeId: options.target!, payload });
  if (controlled.isErr()) throw runControlError(controlled.error);
  const result = controlled.value;
  if (result.type !== "signal") throw new Error(`Daemon returned '${result.type}' for signal control.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Signal consumed.",
    control: appliedControl(result),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, outputFormat(ctx), ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions, action: ControlAction): Promise<void> {
  if (action === "fork" && options.target === "") throw usageError("--target must be a non-empty string.");
  const replacementInput = action === "fork" && options.input !== undefined
    ? await parseInput(options.input, ctx.cwd)
    : undefined;
  const prepared = action === "fork" && options.workflow ? await prepareWorkflowForCli(options.workflow, ctx.cwd) : undefined;
  const agentOverrides = action === "fork" ? parseAgents(options.agents) : undefined;
  const forkInput = await maybeNormalizeForkInput(ctx, runId, action, replacementInput, prepared);
  const base = { requestId: daemonControlRequestId(), runId };
  const intent: DaemonControlIntent = action === "pause" || action === "resume"
      ? { ...base, type: action }
      : action === "retry" || action === "cancel"
        ? { ...base, type: action, ...(options.target ? { target: options.target } : {}) }
        : {
            ...base,
            type: "fork",
            ...(options.target ? { target: options.target } : {}),
            ...(prepared ? { prepared } : {}),
            ...(forkInput !== undefined ? { input: forkInput } : {}),
            ...(agentOverrides !== undefined ? { agentOverrides } : {}),
            ...(options.unsafeReuse === true ? { unsafeReuse: true } : {}),
          };
  const controlled = await sendDaemonControl(ctx.cwd, intent);
  if (controlled.isErr()) throw runControlError(controlled.error);
  const result = controlled.value;
  if (result.type !== action) throw new Error(`Daemon returned '${result.type}' for ${action} control.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: controlSuccessMessage(action),
    control: appliedControl(result),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, outputFormat(ctx), ctx, 0));
}

function controlSuccessMessage(type: Exclude<DaemonControlResult["type"], "signal">): string {
  switch (type) {
    case "pause": return "Run paused.";
    case "resume": return "Run resumed.";
    case "retry": return "Retry applied.";
    case "fork": return "Fork run created.";
    case "cancel": return "Run canceled.";
  }
}

function appliedControl(result: DaemonControlResult): CliAppliedControl {
  switch (result.type) {
    case "pause":
    case "resume":
      return { type: result.type, state: "applied", runId: result.run.id };
    case "retry":
    case "cancel":
      return { type: result.type, state: "applied", runId: result.run.id, ...(result.target === undefined ? {} : { target: result.target }) };
    case "fork":
      return { type: "fork", state: "applied", sourceRunId: result.sourceRunId };
    case "signal":
      return {
        type: "signal",
        state: "consumed",
        runId: result.run.id,
        requestedTarget: result.requestedTarget,
        target: result.target,
        validation: result.validation,
      };
  }
}

async function maybeNormalizeForkInput(
  ctx: RunsCommandContext,
  runId: string,
  action: ControlAction,
  replacementInput: JsonValue | undefined,
  prepared: PreparedRunWorkflow | undefined,
): Promise<JsonValue | undefined> {
  if (action !== "fork") return undefined;
  if (replacementInput === undefined && !prepared) return undefined;
  const normalized = await tryNormalizeForkInput(ctx.cwd, runId, replacementInput, prepared);
  if (normalized.isErr()) throw validationError(normalized.error.message);
  return normalized.value;
}

function outputFormat(ctx: RunsCommandContext): OutputFormat {
  return ctx.wantsJson ? "json" : "text";
}

function runControlError(error: DaemonControlFailure): ReturnType<typeof controlError> {
  return controlError(error.message, {
    errorCode: error.code,
    control: { type: error.controlType, runId: error.runId },
    ...(error.run ? { run: toRunRecord(error.run) } : {}),
  });
}

function terminalRun(run: RunDetails): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "canceled";
}
