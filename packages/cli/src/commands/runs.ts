import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import { tryParseDurationMs } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { deleteRun as deleteRuntimeRun, getRun, getRunInspection, listArtifacts, listRuns, pruneRuns as pruneRuntimeRuns, tryNormalizeForkInput, type ArtifactRecord, type DaemonControlIntent, type DaemonControlResult, type FollowRunInspectionQuery, type PreparedRunWorkflow, type PruneReport, type RunDetails, type RunInspectionError, type RunInspectionQuery, type RunRecord } from "@acpus/runtime";
import { controlError, deleteError, notFoundError, usageError, validationError } from "../errors.js";
import { writeResult, type CliAppliedControl, type OutputFormat } from "../output.js";
import { followRun, parseFollowInterval } from "../run-follow.js";
import { formatRunInspectionDocument } from "../run-inspection-surface.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import type { WorkflowCatalogScopeOptions } from "../catalog.js";
import { parseAgents, parseInput, parseRequiredPayload } from "./json.js";
import { confirmAction, confirmDelete, pickRunId, pickRunsToDelete, type DeleteRunChoice } from "./runs-picker.js";
import { canPrompt } from "./prompt-io.js";
import { daemonControlRequestId, sendDaemonControl, type DaemonControlFailure } from "./daemon.js";
import { outputFormatFor, withJsonOutput, type JsonOutputOptions } from "./output-option.js";
import { toRunRecord } from "../run-record.js";

export type RunsCommandContext = {
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type Target = {
  target?: string;
};

type TargetOptions = Target & JsonOutputOptions;

type ForkMutation = Target & WorkflowCatalogScopeOptions & {
  input?: string;
  workflow?: string;
  agents?: string;
  unsafeReuse?: boolean;
};

type ForkOptions = ForkMutation & JsonOutputOptions;

type SignalOptions = JsonOutputOptions & {
  target: string;
  payload: string;
};

type SteerOptions = JsonOutputOptions & {
  target: string;
  instruction: string;
};

type InspectRunOptions = JsonOutputOptions & {
  target?: string;
  all?: boolean;
  timeline?: boolean;
  limit?: string;
  before?: string;
  follow?: boolean;
  interval?: string;
  raw?: boolean;
};

type CliRunInspectionQuery = Exclude<
  RunInspectionQuery,
  { mode: "details" | "execution" }
>;

type ArtifactsRunOptions = JsonOutputOptions & {
  target?: string;
};

type PruneRunOptions = JsonOutputOptions & {
  olderThan?: string;
  allWorkspaces?: boolean;
  dryRun?: boolean;
  yes?: boolean;
};

type ControlAction = "pause" | "resume" | "retry" | "fork" | "cancel";
type RunMutation =
  | { type: "pause" | "resume" }
  | ({ type: "retry" | "cancel" } & Target)
  | ({ type: "fork" } & ForkMutation);

export function createRunsCommand(ctx: RunsCommandContext): Command {
  const command = new Command("runs")
    .exitOverride()
    .description("Inspect and control durable runs.");

  command.addCommand(withJsonOutput(new Command("inspect")
    .exitOverride()
    .description("Inspect durable run structure and status.")
    .argument("[run-id]", "run id")
    .option("--target <run-target>", "inspect one static node, dynamic node, frame, or attempt")
    .option("--timeline", "show current activity and recent semantic history for the target")
    .option("--limit <count>", "limit Timeline entries (default: 12, maximum: 50)")
    .option("--before <page-cursor>", "read an older Timeline page")
    .option("--all", "expand every dynamic run context")
    .option("--follow", "follow run status until completion or Ctrl-C")
    .option("--interval <duration>", "refresh followed status (default: 1s, minimum: 250ms)")
    .option("--raw", "emit the raw scheduler inspection bundle (requires --json)")
    ).action(async (runId: string | undefined, options: InspectRunOptions) => {
      await inspectRunCommand(ctx, runId, options);
    }));

  command.addCommand(withJsonOutput(new Command("artifacts")
    .exitOverride()
    .description("List artifact metadata and absolute paths.")
    .argument("<run-id>", "run id")
    .option("--target <run-target>", "list artifacts for one static node, dynamic node, frame, or attempt")
    ).action(async (runId: string, options: ArtifactsRunOptions) => {
      await artifactsRunCommand(ctx, runId, options);
    }));

  command.addCommand(withJsonOutput(new Command("delete")
    .exitOverride()
    .description("Delete durable run state and run-local artifacts.")
    .argument("[run-id]", "run id")
    ).action(async (runId: string | undefined, options: JsonOutputOptions) => {
      await deleteRunCommand(ctx, runId, outputFormatFor(options));
    }));

  command.addCommand(withJsonOutput(new Command("prune")
    .exitOverride()
    .description("Delete terminal runs selected by age.")
    .option("--older-than <duration>", "select runs older than a duration such as 30d")
    .option("--all-workspaces", "select runs from every known workspace")
    .option("--dry-run", "report selected runs without deleting them")
    .option("--yes", "skip the interactive confirmation")
    ).action(async (options: PruneRunOptions) => {
      await pruneRunsCommand(ctx, options);
    }));

  for (const name of ["pause", "resume", "retry", "cancel"] as const) {
    const control = withJsonOutput(new Command(name)
      .exitOverride()
      .description(controlDescription(name))
      .argument("<run-id>", "run id")
    ).action(async (runId: string, options: TargetOptions) => {
      const request: RunMutation = name === "pause" || name === "resume"
        ? { type: name }
        : { type: name, ...(options.target === undefined ? {} : { target: options.target }) };
      await mutateRun(ctx, runId, request, outputFormatFor(options));
    });
    if (name === "retry") control.option("--target <run-target>", "retry only a failed run target");
    if (name === "cancel") control.option("--target <run-target>", "cancel only a non-terminal run target");
    command.addCommand(control);
  }

  command.addCommand(withJsonOutput(new Command("fork")
    .exitOverride()
    .description("Fork a run, optionally replacing its workflow or recovery target.")
    .argument("<run-id>", "run id")
    .option("--workflow <workflow-module>", "use a replacement workflow module path or - for stdin")
    .option("--project", "resolve replacement workflow name from the project catalog")
    .option("--global", "resolve replacement workflow name from the global catalog")
    .option("--input <json|file.json>", "override workflow input with inline JSON or a JSON file")
    .option("--agents <json>", "override inherited agents for the fork")
    .option("--target <run-target>", "target a replacement workflow recovery point")
    .option("--unsafe-reuse", "dangerously reuse completed fork prerequisites despite workflow, input, or signature changes")
    ).action(async (runId: string, options: ForkOptions) => {
      await mutateRun(ctx, runId, {
        type: "fork",
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
        ...(options.project === true ? { project: true } : {}),
        ...(options.global === true ? { global: true } : {}),
        ...(options.agents === undefined ? {} : { agents: options.agents }),
        ...(options.unsafeReuse === true ? { unsafeReuse: true } : {}),
      }, outputFormatFor(options));
    }));

  command.addCommand(withJsonOutput(new Command("signal")
    .exitOverride()
    .description("Deliver a payload to one open Signal wait.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "signal wait target")
    .requiredOption("--payload <json>", "signal payload JSON")
    ).action(async (runId: string, options: SignalOptions) => {
      await signalRun(ctx, runId, options, outputFormatFor(options));
    }));

  command.addCommand(withJsonOutput(new Command("steer")
    .exitOverride()
    .description("Correct one running Agent attempt.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "running Agent attempt, dynamic node, or static node")
    .requiredOption("--instruction <text>", "correction for the replacement Agent turn")
    ).action(async (runId: string, options: SteerOptions) => {
      await steerRun(ctx, runId, options, outputFormatFor(options));
    }));

  return command;
}

async function inspectRun(ctx: RunsCommandContext, runId: string, options: InspectRunOptions): Promise<void> {
  const query = inspectionQuery(runId, options);
  if (options.follow) {
    if (query.mode === "raw") throw usageError("--raw cannot be followed.");
    const followQuery: FollowRunInspectionQuery = {
      ...query,
      intervalMs: parseFollowInterval(options.interval),
    };
    const outcome = await followRun(ctx.cwd, followQuery, {
      phase: "inspect",
      format: outputFormatFor(options) === "json" ? "ndjson" : "text",
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    });
    ctx.setExitCode(outcome.kind === "error" ? 1 : 0);
    return;
  }

  const inspected = await getRunInspection(ctx.cwd, query);
  if (inspected.isErr()) throw inspectionError(inspected.error);
  if (outputFormatFor(options) === "json") {
    ctx.stdout.write(`${JSON.stringify({ ok: true, phase: "inspect", ...inspected.value }, null, 2)}\n`);
  } else {
    ctx.stdout.write(formatRunInspectionDocument(inspected.value));
  }
  ctx.setExitCode(0);
}

async function inspectRunCommand(ctx: RunsCommandContext, runId: string | undefined, options: InspectRunOptions): Promise<void> {
  validateInspectOptions(options);
  if (runId !== undefined) {
    await inspectRun(ctx, runId, options);
    return;
  }
  if (outputFormatFor(options) === "json") throw usageError("Run id is required when --json is used.");
  if (!canPrompt(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const runs = await listRuns(ctx.cwd);
  if (runs.length === 0) throw notFoundError("No runs found.");

  const selectedRunId = await pickRunId(runs, ctx);
  if (selectedRunId === undefined) throw usageError("Run selection cancelled.");
  await inspectRun(ctx, selectedRunId, options);
}

function inspectionQuery(runId: string, options: InspectRunOptions): CliRunInspectionQuery {
  if (options.raw) return { runId, mode: "raw" };
  if (options.timeline) {
    const page = {
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
      ...(options.before === undefined ? {} : { before: options.before }),
    };
    return {
      runId,
      mode: "timeline",
      target: options.target!,
      ...(Object.keys(page).length === 0 ? {} : { page }),
    };
  }
  if (options.target !== undefined) return { runId, mode: "target", target: options.target };
  if (options.all) return { runId, mode: "all" };
  return { runId, mode: "overview" };
}

function inspectionError(error: RunInspectionError): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  const inspectionError = error.type === "inspection-read-failed"
    ? { type: error.type, runId: error.runId, message: error.message }
    : error;
  return notFoundError(error.message, {
    errorCode: error.type.replaceAll("-", "_").toUpperCase(),
    inspectionError,
  });
}

async function artifactsRunCommand(ctx: RunsCommandContext, runId: string, options: ArtifactsRunOptions): Promise<void> {
  if (options.target === "") throw usageError("--target must be a non-empty string.");
  let artifacts: ArtifactRecord[];
  if (options.target === undefined) {
    const listed = await listArtifacts(ctx.cwd, runId);
    if (listed === undefined) throw notFoundError(`Run '${runId}' was not found.`, { errorCode: "RUN_NOT_FOUND" });
    artifacts = listed;
  } else {
    const inspected = await getRunInspection(ctx.cwd, { runId, mode: "details", target: options.target });
    if (inspected.isErr()) throw inspectionError(inspected.error);
    if (inspected.value.kind !== "details") throw new Error("Target details inspection returned an unexpected document.");
    artifacts = inspected.value.artifacts;
  }

  if (outputFormatFor(options) === "json") {
    ctx.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
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

function validateInspectOptions(options: InspectRunOptions): void {
  if (options.target !== undefined && options.target.trim().length === 0) {
    throw usageError("--target must be a non-empty string.");
  }
  if (options.before !== undefined && options.before.trim().length === 0) {
    throw usageError("--before must be a non-empty cursor.");
  }
  if (options.target !== undefined && options.all) throw usageError("--target cannot be used with --all.");
  if (options.timeline && options.target === undefined) throw usageError("--timeline requires --target.");
  if (options.timeline && (options.all || options.raw)) throw usageError("--timeline cannot be used with --all or --raw.");
  if (options.limit !== undefined && !options.timeline) throw usageError("--limit requires --timeline.");
  if (options.before !== undefined && !options.timeline) throw usageError("--before requires --timeline.");
  if (options.limit !== undefined && (!/^\d+$/.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 50)) {
    throw usageError("--limit must be an integer from 1 to 50.");
  }
  if (options.before !== undefined && options.follow) {
    throw usageError("--before cannot be used with --follow.");
  }
  if (options.interval !== undefined && !options.follow) throw usageError("--interval requires --follow.");
  if (options.raw && outputFormatFor(options) !== "json") throw usageError("--raw requires --json.");
  if (options.raw && (options.follow || options.all || options.target !== undefined)) {
    throw usageError("--raw cannot be used with --follow, --all, or --target.");
  }
  if (options.follow) void parseFollowInterval(options.interval);
}

async function deleteRunCommand(ctx: RunsCommandContext, runId: string | undefined, format: OutputFormat): Promise<void> {
  if (runId !== undefined) {
    const deleted = await deleteOneRun(ctx, runId);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "delete",
      message: "Run deleted.",
      run: deleted,
      deletedRuns: [deleted],
      skippedRuns: [],
    }, format, ctx, 0));
    return;
  }
  if (format === "json") throw usageError("Run id is required when --json is used.");
  if (!canPrompt(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

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
  }, format, ctx, 0));
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

async function pruneRunsCommand(ctx: RunsCommandContext, options: PruneRunOptions): Promise<void> {
  const format = outputFormatFor(options);
  const olderThanMs = parsePruneAge(options.olderThan);
  const selectionCutoff = new Date(Date.now() - (olderThanMs ?? 0)).toISOString();
  const request = {
    ...(olderThanMs === undefined ? {} : { olderThanMs }),
    allWorkspaces: options.allWorkspaces ?? false,
    selectionCutoff,
  };
  if (!options.dryRun && !options.yes && (format === "json" || !canPrompt(ctx))) {
    throw usageError("--yes is required to prune runs without an interactive terminal.");
  }
  const preview = await pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: true });
  const selectedItems = preview.selected.runs + preview.selected.archives;
  if (options.dryRun) {
    writePruneResult(ctx, preview, "Prune preview.", format);
    return;
  }
  if (selectedItems === 0 && preview.failures.length === 0 && !options.yes) {
    writePruneResult(ctx, preview, "No runs to prune.", format);
    return;
  }
  if (!options.yes) {
    writeResult({
      ok: preview.failures.length === 0,
      phase: "delete",
      message: "Prune preview.",
      prune: preview,
    }, "text", ctx, preview.failures.length === 0 ? 0 : 1);
    const confirmed = preview.failures.length === 0
      ? await confirmDelete(selectedItems, ctx, "item")
      : await confirmAction(
          `Prune ${selectedItems} selected item${selectedItems === 1 ? "" : "s"} and retry ${preview.failures.length} unresolved workspace${preview.failures.length === 1 ? "" : "s"}?`,
          ctx,
        );
    if (confirmed !== true) throw usageError("Run pruning cancelled.");
  }

  const report = await pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: false });
  writePruneResult(ctx, report, report.failures.length === 0 ? "Runs pruned." : "Run pruning completed with failures.", format);
}

function parsePruneAge(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = tryParseDurationMs(value);
  if (parsed.isErr()) throw usageError("--older-than must be a duration such as 30d, 24h, or 15m.");
  return parsed.value;
}

function writePruneResult(ctx: RunsCommandContext, report: PruneReport, message: string, format: OutputFormat): void {
  const exitCode = report.failures.length === 0 ? 0 : 1;
  ctx.setExitCode(writeResult({
    ok: exitCode === 0,
    phase: "delete",
    message,
    prune: report,
  }, format, ctx, exitCode));
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: SignalOptions, format: OutputFormat): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  const controlled = await sendDaemonControl(ctx.cwd, { requestId: daemonControlRequestId(), type: "signal", runId, nodeId: options.target, payload });
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
  }, format, ctx, 0));
}

async function steerRun(ctx: RunsCommandContext, runId: string, options: SteerOptions, format: OutputFormat): Promise<void> {
  if (options.target.trim() === "") throw usageError("--target must be a non-empty string.");
  if (options.instruction.trim() === "") throw usageError("--instruction must be a non-empty string.");
  const controlled = await sendDaemonControl(ctx.cwd, {
    requestId: daemonControlRequestId(),
    type: "steer",
    runId,
    target: options.target,
    instruction: options.instruction,
  });
  if (controlled.isErr()) throw runControlError(controlled.error);
  const result = controlled.value;
  if (result.type !== "steer") throw new Error(`Daemon returned '${result.type}' for steer control.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Attempt fenced; correction queued.",
    control: appliedControl(result),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, format, ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, request: RunMutation, format: OutputFormat): Promise<void> {
  if (request.type === "fork" && request.target === "") throw usageError("--target must be a non-empty string.");
  if (request.type === "fork" && request.project && request.global) {
    throw usageError("--project and --global are mutually exclusive.");
  }
  if (request.type === "fork" && (request.project || request.global) && request.workflow === undefined) {
    throw usageError("Catalog scope flags require --workflow.");
  }
  const replacementInput = request.type === "fork" && request.input !== undefined
    ? await parseInput(request.input, ctx.cwd)
    : undefined;
  const preparation = request.type === "fork" && request.workflow !== undefined
    ? await prepareWorkflowForCli({
        workspaceDir: ctx.cwd,
        workflow: request.workflow,
        stdin: ctx.stdin,
        ...(request.project ? { project: true } : {}),
        ...(request.global ? { global: true } : {}),
      })
    : undefined;
  const prepared = preparation?.prepared;
  const agentOverrides = request.type === "fork" ? parseAgents(request.agents) : undefined;
  const forkInput = request.type === "fork" ? await maybeNormalizeForkInput(ctx, runId, replacementInput, prepared) : undefined;
  const base = { requestId: daemonControlRequestId(), runId };
  let intent: DaemonControlIntent;
  switch (request.type) {
    case "pause":
    case "resume":
      intent = { ...base, type: request.type };
      break;
    case "retry":
    case "cancel":
      intent = { ...base, type: request.type, ...(request.target ? { target: request.target } : {}) };
      break;
    case "fork":
      intent = {
        ...base,
        type: "fork",
        ...(request.target ? { target: request.target } : {}),
        ...(prepared ? { prepared } : {}),
        ...(forkInput !== undefined ? { input: forkInput } : {}),
        ...(agentOverrides !== undefined ? { agentOverrides } : {}),
        ...(request.unsafeReuse === true ? { unsafeReuse: true } : {}),
      };
      break;
  }
  const controlled = await sendDaemonControl(ctx.cwd, intent);
  if (controlled.isErr()) throw runControlError(controlled.error);
  const result = controlled.value;
  if (result.type !== request.type) throw new Error(`Daemon returned '${result.type}' for ${request.type} control.`);
  const control = appliedControl(result);
  const run = toRunRecord(result.run);
  const follow = terminalRun(result.run) ? {} : { followRunId: result.run.id };
  if (control.type === "fork") {
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "control",
      message: controlSuccessMessage(request.type),
      control,
      run,
      ...follow,
      ...(preparation === undefined
        ? {}
        : {
            diagnostics: preparation.prepared.ir.diagnostics,
            sourceGraphDigest: preparation.prepared.sourceGraphDigest,
            ...(preparation.catalog === undefined ? {} : { catalog: preparation.catalog }),
          }),
    }, format, ctx, 0));
    return;
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: controlSuccessMessage(request.type),
    control,
    run,
    ...follow,
  }, format, ctx, 0));
}

function controlDescription(type: Exclude<ControlAction, "fork">): string {
  switch (type) {
    case "pause": return "Pause a run and its active attempts.";
    case "resume": return "Resume a paused run.";
    case "retry": return "Retry a failed run or target.";
    case "cancel": return "Cancel a run or non-terminal target.";
  }
}

function controlSuccessMessage(type: Exclude<DaemonControlResult["type"], "signal" | "steer">): string {
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
    case "steer":
      return {
        type: "steer",
        state: "applied",
        runId: result.run.id,
        steerId: result.steerId,
        requestedTarget: result.requestedTarget,
        target: result.target,
        fencedAttemptId: result.fencedAttemptId,
        continuation: result.continuation,
      };
  }
}

async function maybeNormalizeForkInput(
  ctx: RunsCommandContext,
  runId: string,
  replacementInput: JsonValue | undefined,
  prepared: PreparedRunWorkflow | undefined,
): Promise<JsonValue | undefined> {
  if (replacementInput === undefined && !prepared) return undefined;
  const normalized = await tryNormalizeForkInput(ctx.cwd, runId, replacementInput, prepared);
  if (normalized.isErr()) throw validationError(normalized.error.message);
  return normalized.value;
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
