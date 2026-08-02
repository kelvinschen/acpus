import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import { tryParseDurationMs } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import {
  deleteRun as deleteRuntimeRun,
  getRun,
  inspectTargetArtifacts,
  listArtifacts,
  listRuns,
  pruneRuns as pruneRuntimeRuns,
  readInspection,
  resolveArtifact,
  tryNormalizeForkInput,
  type ArtifactResolutionFailure,
  type ArtifactRecord,
  type DaemonControlIntent,
  type DaemonControlResult,
  type InspectionCandidates,
  type InspectionError,
  type InspectionRead,
  type InspectionViewQuery,
  type PreparedRunWorkflow,
  type PruneReport,
  type RunDetails,
  type RunRecord,
} from "@acpus/runtime";
import { controlError, deleteError, notFoundError, usageError, validationError } from "../errors.js";
import { followExitCode, followRun } from "../run-follow.js";
import {
  formatInspectionCandidates,
  formatInspectionView,
} from "../run-inspection-surface.js";
import { writeJsonLine, writeResult, type CliAppliedControl } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import type { WorkflowCatalogScopeOptions } from "../catalog.js";
import { parseAgents, parseInput, parseRequiredPayload } from "./json.js";
import { confirmAction, confirmDelete, pickRunId, pickRunsToDelete, type DeleteRunChoice } from "./runs-picker.js";
import { canPrompt } from "./prompt-io.js";
import { daemonControlRequestId, sendDaemonControl, type DaemonControlFailure } from "./daemon.js";
import { jsonOutputFor, withJsonOutput, type JsonOutputOptions } from "./output-option.js";
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

type TargetOptions = Target;

type ForkMutation = Target & WorkflowCatalogScopeOptions & {
  input?: string;
  workflow?: string;
  agents?: string;
};

type ForkOptions = ForkMutation;

type SignalOptions = {
  target: string;
  payload: string;
};

type SteerOptions = {
  target: string;
  instruction: string;
};

type InspectRunOptions = {
  target?: string;
  timeline?: boolean;
  page?: string;
  follow?: boolean;
  awaitDecision?: boolean;
};

type ArtifactsRunOptions = JsonOutputOptions & {
  target?: string;
};

type ArtifactRunOptions = JsonOutputOptions;

type PruneRunOptions = {
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

  command.addCommand(new Command("inspect")
    .exitOverride()
    .description("Inspect durable run structure and status.")
    .argument("[run-id]", "run id")
    .option("--target <run-target>", "inspect one authored target or @occurrence reference")
    .option("--timeline", "show current activity and recent semantic history for the target")
    .option("--page <number>", "read a one-based ambiguous-target candidate page")
    .option("--follow", "wait until the selected run or target becomes terminal; Ctrl-C detaches")
    .option("--await-decision", "wait until the next external decision boundary; Ctrl-C detaches")
    .action(async (runId: string | undefined, options: InspectRunOptions) => {
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

  command.addCommand(withJsonOutput(new Command("artifact")
    .exitOverride()
    .description("Locate an artifact's verified local source.")
    .argument("<artifact-ref>", "artifact://<run-id>/<artifact-id>")
    ).action(async (artifactRef: string, options: ArtifactRunOptions) => {
      await artifactRunCommand(ctx, artifactRef, options);
    }));

  command.addCommand(new Command("delete")
    .exitOverride()
    .description("Delete durable run state and run-local artifacts.")
    .argument("[run-id]", "run id")
    .action(async (runId: string | undefined) => {
      await deleteRunCommand(ctx, runId);
    }));

  command.addCommand(new Command("prune")
    .exitOverride()
    .description("Delete terminal runs selected by age.")
    .option("--older-than <duration>", "select runs older than a duration such as 30d")
    .option("--all-workspaces", "select runs from every known workspace")
    .option("--dry-run", "report selected runs without deleting them")
    .option("--yes", "skip the interactive confirmation")
    .action(async (options: PruneRunOptions) => {
      await pruneRunsCommand(ctx, options);
    }));

  for (const name of ["pause", "resume", "retry", "cancel"] as const) {
    const control = new Command(name)
      .exitOverride()
      .description(controlDescription(name))
      .argument("<run-id>", "run id")
      .action(async (runId: string, options: TargetOptions) => {
        const request: RunMutation = name === "pause" || name === "resume"
          ? { type: name }
          : { type: name, ...(options.target === undefined ? {} : { target: options.target }) };
        await mutateRun(ctx, runId, request);
      });
    if (name === "retry") control.option("--target <run-target>", "retry only a failed run target");
    if (name === "cancel") control.option("--target <run-target>", "cancel only a non-terminal run target");
    command.addCommand(control);
  }

  command.addCommand(new Command("fork")
    .exitOverride()
    .description("Fork a run with optional workflow, input, or Agent changes.")
    .argument("<run-id>", "run id")
    .option("--workflow <workflow-module>", "use a replacement workflow module path or - for stdin")
    .option("--project", "resolve replacement workflow name from the project catalog")
    .option("--global", "resolve replacement workflow name from the global catalog")
    .option("--input <json|file.json>", "override workflow input with inline JSON or a JSON file")
    .option("--agents <json>", "override inherited agents for the fork")
    .option("--target <source-occurrence>", "rewind: rerun this occurrence and later work; omit #attemptNo")
    .action(async (runId: string, options: ForkOptions) => {
      await mutateRun(ctx, runId, {
        type: "fork",
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
        ...(options.project === true ? { project: true } : {}),
        ...(options.global === true ? { global: true } : {}),
        ...(options.agents === undefined ? {} : { agents: options.agents }),
      });
    }));

  command.addCommand(new Command("signal")
    .exitOverride()
    .description("Deliver a payload to one open Signal wait.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "signal wait target")
    .requiredOption("--payload <json>", "signal payload JSON")
    .action(async (runId: string, options: SignalOptions) => {
      await signalRun(ctx, runId, options);
    }));

  command.addCommand(new Command("steer")
    .exitOverride()
    .description("Apply an admitted in-scope information update to one running Agent attempt.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "running Agent attempt, dynamic node, or static node")
    .requiredOption("--instruction <text>", "admitted in-scope information update or constraint")
    .action(async (runId: string, options: SteerOptions) => {
      await steerRun(ctx, runId, options);
    }));

  return command;
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

  const document = await inspectionDocument(ctx.cwd, runId, options);
  ctx.stdout.write(document.kind === "candidates"
    ? formatInspectionCandidates(document, { timeline: options.timeline === true })
    : formatInspectionView(document));
  ctx.setExitCode(0);
}

async function inspectRunCommand(ctx: RunsCommandContext, runId: string | undefined, options: InspectRunOptions): Promise<void> {
  validateInspectOptions(options);
  if (runId !== undefined) {
    await inspectRun(ctx, runId, options);
    return;
  }
  if (!canPrompt(ctx)) throw usageError("Run id is required when not running in an interactive terminal.");

  const runs = await listRuns(ctx.cwd);
  if (runs.length === 0) throw notFoundError("No runs found.");

  const selectedRunId = await pickRunId(runs, ctx);
  if (selectedRunId === undefined) throw usageError("Run selection cancelled.");
  await inspectRun(ctx, selectedRunId, options);
}

async function inspectionDocument(
  cwd: string,
  runId: string,
  options: InspectRunOptions,
): Promise<InspectionRead> {
  const inspected = await readInspection(cwd, {
    view: inspectionViewQuery(runId, options),
    ...(options.page === undefined ? {} : { candidatePage: Number(options.page) }),
  });
  if (inspected.isErr()) throw inspectionError(inspected.error);
  return inspected.value;
}

function inspectionViewQuery(runId: string, options: InspectRunOptions): InspectionViewQuery {
  if (options.target !== undefined) {
    return {
      kind: "target",
      runId,
      target: options.target,
      detail: options.timeline ? "timeline" : "summary",
    };
  }
  return { kind: "run", runId };
}

function inspectionError(
  error: InspectionError,
): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  return notFoundError(error.message, {
    errorCode: error.type.replaceAll("-", "_").toUpperCase(),
    inspectionError: error,
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
    const inspected = await inspectTargetArtifacts(ctx.cwd, { runId, target: options.target });
    if (inspected.isErr()) throw artifactInspectionError(inspected.error);
    artifacts = inspected.value.artifacts;
  }

  if (jsonOutputFor(options)) {
    writeJsonLine(ctx.stdout, {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      runId,
      ...(options.target === undefined ? {} : { target: options.target }),
      artifacts,
    });
  } else if (artifacts.length === 0) {
    ctx.stdout.write("No artifacts.\n");
  } else {
    ctx.stdout.write(`${artifacts.map(artifact => `${artifact.id} ${artifact.mediaType ?? "-"} ${artifact.path}`).join("\n")}\n`);
  }
  ctx.setExitCode(0);
}

async function artifactRunCommand(ctx: RunsCommandContext, artifactRef: string, options: ArtifactRunOptions): Promise<void> {
  const resolved = await resolveArtifact(ctx.cwd, artifactRef);
  if (resolved.isErr()) throw artifactResolutionError(resolved.error);
  const artifact = resolved.value;
  if (jsonOutputFor(options)) {
    writeJsonLine(ctx.stdout, {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      artifact,
    });
  } else {
    ctx.stdout.write([
      `Path: ${artifact.path}`,
      `Media-Type: ${artifact.mediaType ?? "-"}`,
      `Size: ${artifact.size} bytes`,
      `Digest: ${artifact.digest}`,
      `Source: ${artifact.nodeKey} attempt ${artifact.attempt}`,
      "",
    ].join("\n"));
  }
  ctx.setExitCode(0);
}

function artifactResolutionError(error: ArtifactResolutionFailure): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-artifact-ref") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}

function artifactInspectionError(error: { type: string; message: string }): ReturnType<typeof notFoundError> | ReturnType<typeof usageError> {
  if (error.type === "invalid-query") return usageError(error.message);
  return notFoundError(error.message, { errorCode: error.type.replaceAll("-", "_").toUpperCase() });
}

function validateInspectOptions(options: InspectRunOptions): void {
  if (options.target !== undefined && options.target.trim().length === 0) {
    throw usageError("--target must be a non-empty string.");
  }
  if (options.timeline && options.target === undefined) throw usageError("--timeline requires --target.");
  if (options.page !== undefined && options.target === undefined) throw usageError("--page requires --target.");
  if (options.page !== undefined && (!/^[1-9]\d*$/.test(options.page) || !Number.isSafeInteger(Number(options.page)))) {
    throw usageError("--page must be a positive integer.");
  }
  if (options.follow && options.awaitDecision) throw usageError("--follow and --await-decision are mutually exclusive.");
  if (options.page !== undefined && (options.follow || options.awaitDecision)) {
    throw usageError("--page cannot be used with --follow or --await-decision.");
  }
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

  const initialSkipped = selection.selectedAll ? choices.filter(choice => choice.disabled === true).map(choice => choice.run) : [];
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
  const preview = await pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: true });
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

  const report = await pruneRuntimeRuns(ctx.cwd, { ...request, dryRun: false });
  writePruneResult(ctx, report, report.failures.length === 0 ? "Runs pruned." : "Run pruning completed with failures.");
}

function parsePruneAge(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = tryParseDurationMs(value);
  if (parsed.isErr()) throw usageError("--older-than must be a duration such as 30d, 24h, or 15m.");
  return parsed.value;
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

async function signalRun(ctx: RunsCommandContext, runId: string, options: SignalOptions): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  const controlled = await sendDaemonControl(ctx.cwd, { requestId: daemonControlRequestId(), type: "signal", runId, nodeId: options.target, payload });
  if (controlled.isErr()) throw await runControlError(ctx, controlled.error, options.target);
  const result = controlled.value;
  if (result.type !== "signal") throw new Error(`Daemon returned '${result.type}' for signal control.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Signal consumed.",
    control: appliedControl(result, options.target),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, ctx, 0));
}

async function steerRun(ctx: RunsCommandContext, runId: string, options: SteerOptions): Promise<void> {
  if (options.target.trim() === "") throw usageError("--target must be a non-empty string.");
  if (options.instruction.trim() === "") throw usageError("--instruction must be a non-empty string.");
  const controlled = await sendDaemonControl(ctx.cwd, {
    requestId: daemonControlRequestId(),
    type: "steer",
    runId,
    target: options.target,
    instruction: options.instruction,
  });
  if (controlled.isErr()) throw await runControlError(ctx, controlled.error, options.target);
  const result = controlled.value;
  if (result.type !== "steer") throw new Error(`Daemon returned '${result.type}' for steer control.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: "Attempt fenced; information update queued.",
    control: appliedControl(result, options.target),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, request: RunMutation): Promise<void> {
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
  const requestedTarget = "target" in request ? request.target : undefined;
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
      };
      break;
  }
  const controlled = await sendDaemonControl(ctx.cwd, intent);
  if (controlled.isErr()) throw await runControlError(ctx, controlled.error, requestedTarget);
  const result = controlled.value;
  if (result.type !== request.type) throw new Error(`Daemon returned '${result.type}' for ${request.type} control.`);
  const control = appliedControl(result, requestedTarget);
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
            ...(preparation.catalog === undefined ? {} : { catalog: preparation.catalog }),
          }),
    }, ctx, 0));
    return;
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "control",
    message: controlSuccessMessage(request.type),
    control,
    run,
    ...follow,
  }, ctx, 0));
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

function appliedControl(result: DaemonControlResult, requestedTarget?: string): CliAppliedControl {
  switch (result.type) {
    case "pause":
    case "resume":
      return { type: result.type, state: "applied", runId: result.run.id };
    case "retry":
    case "cancel":
      return {
        type: result.type,
        state: "applied",
        runId: result.run.id,
        ...((requestedTarget ?? result.target) === undefined ? {} : { target: requestedTarget ?? result.target! }),
      };
    case "fork":
      return { type: "fork", state: "applied", sourceRunId: result.sourceRunId };
    case "signal":
      return {
        type: "signal",
        state: "consumed",
        runId: result.run.id,
        target: requestedTarget ?? result.requestedTarget,
        validation: result.validation,
      };
    case "steer":
      return {
        type: "steer",
        state: "applied",
        runId: result.run.id,
        steerId: result.steerId,
        target: requestedTarget ?? result.requestedTarget,
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

async function runControlError(
  ctx: RunsCommandContext,
  error: DaemonControlFailure,
  target: string | undefined,
): Promise<ReturnType<typeof controlError>> {
  const candidates = target === undefined
    || error.cause.type !== "rejected"
    || error.cause.ambiguity !== true
    ? undefined
    : await controlCandidates(ctx.cwd, error.runId, target);
  const inspectionError = candidates === undefined || target === undefined
    ? undefined
    : {
        type: "target-ambiguous" as const,
        runId: error.runId,
        target,
        candidates,
        message: `Control '${error.controlType}' target '${target}' matches multiple occurrences. Select one @ref from the candidate view.`,
      };
  const message = inspectionError?.message ?? error.message;
  return controlError(candidates
    ? `${formatInspectionCandidates(candidates).trimEnd()}\n${message}`
    : message, {
    errorCode: error.code,
    control: { type: error.controlType, runId: error.runId },
    ...(error.run ? { run: toRunRecord(error.run) } : {}),
    ...(inspectionError ? { inspectionError } : {}),
  });
}

async function controlCandidates(
  cwd: string,
  runId: string,
  target: string,
): Promise<InspectionCandidates | undefined> {
  const inspected = await readInspection(cwd, {
    view: { kind: "target", runId, target, detail: "summary" },
  });
  return inspected.isOk() && inspected.value.kind === "candidates"
    ? inspected.value
    : undefined;
}

function terminalRun(run: RunDetails): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "canceled";
}
