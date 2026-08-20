import { Command } from "commander";
import type { JsonValue } from "@acpus/expression/ir";
import {
  readInspection,
  tryNormalizeForkInput,
  type DaemonControlIntent,
  type DaemonControlResult,
  type ForkInputNormalizationFailure,
  type InspectionCandidates,
  type PreparedRunWorkflow,
  type RunDetails,
  type RuntimeReadFailure,
} from "@acpus/runtime";
import type { WorkflowCatalogScopeOptions } from "../workflow/catalog.js";
import { controlError, usageError, validationError } from "../presentation/errors.js";
import { parseAgents, parseInput, parseRequiredPayload } from "../presentation/json-input.js";
import { writeResult, type CliAppliedControl, type CliResult } from "../presentation/output.js";
import {
  daemonControlRequestId,
  sendDaemonControl,
  type DaemonControlFailure,
} from "../daemon/client.js";
import { prepareWorkflowForCli } from "../workflow/preparation.js";
import type { RunsCommandContext } from "./context.js";
import { formatInspectionCandidates } from "./inspection-surface.js";
import { toRunRecord } from "./record.js";
import { runtimeReadFailureCode, runtimeReadFailureMessage } from "./runtime-read.js";

type Target = {
  target?: string;
};

type ForkMutation = Target & WorkflowCatalogScopeOptions & {
  input?: string;
  workflow?: string;
  agents?: string;
};

type SignalOptions = {
  target: string;
  payload: string;
};

type SteerOptions = {
  target: string;
  instruction: string;
};

type ControlAction = "pause" | "resume" | "retry" | "fork" | "cancel";

type RunMutation =
  | { type: "pause" | "resume" }
  | { type: "retry"; target: string }
  | ({ type: "cancel" } & Target)
  | ({ type: "fork" } & ForkMutation);

export function createControlCommands(ctx: RunsCommandContext): Command[] {
  const commands: Command[] = [];
  for (const name of ["pause", "resume", "cancel"] as const) {
    const control = new Command(name)
      .exitOverride()
      .description(controlDescription(name))
      .argument("<run-id>", "run id")
      .action(async (runId: string, options: Target) => {
        const request: RunMutation = name === "pause" || name === "resume"
          ? { type: name }
          : { type: name, ...(options.target === undefined ? {} : { target: options.target }) };
        await mutateRun(ctx, runId, request);
      });
    if (name === "cancel") control.option("--target <run-target>", "cancel only a non-terminal run target");
    commands.push(control);
  }

  commands.push(new Command("retry")
    .exitOverride()
    .description(controlDescription("retry"))
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "failed or timed-out Task, Agent, or frame target")
    .action(async (runId: string, options: { target: string }) => {
      await mutateRun(ctx, runId, { type: "retry", target: options.target });
    }));

  commands.push(new Command("fork")
    .exitOverride()
    .description("Fork a run with optional workflow, input, or Agent changes.")
    .argument("<run-id>", "run id")
    .option("--workflow <workflow-module>", "use a replacement workflow module path or - for stdin")
    .option("--project", "resolve replacement workflow name from the project catalog")
    .option("--global", "resolve replacement workflow name from the global catalog")
    .option("--input <json|file.json>", "override workflow input with inline JSON or a JSON file")
    .option("--agents <json|file.json>", "override inherited agents with inline JSON or a JSON file")
    .option("--target <source-occurrence>", "rewind: rerun this occurrence and later work; omit #attemptNo")
    .action(async (runId: string, options: ForkMutation) => {
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

  commands.push(new Command("signal")
    .exitOverride()
    .description("Deliver a payload to one open Signal wait.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "signal wait target")
    .requiredOption("--payload <json>", "signal payload JSON")
    .action(async (runId: string, options: SignalOptions) => {
      await signalRun(ctx, runId, options);
    }));

  commands.push(new Command("steer")
    .exitOverride()
    .description("Steer a running Agent by interrupting its current Turn, draining it, then continuing the same Session.")
    .argument("<run-id>", "run id")
    .requiredOption("--target <run-target>", "running Agent attempt, dynamic node, or static node")
    .requiredOption("--instruction <text>", "admitted in-scope information update or constraint")
    .action(async (runId: string, options: SteerOptions) => {
      await steerRun(ctx, runId, options);
    }));

  return commands;
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: SignalOptions): Promise<void> {
  const payload = parseRequiredPayload(options.payload);
  const controlled = await sendDaemonControl(ctx.cwd, {
    requestId: daemonControlRequestId(),
    type: "signal",
    runId,
    nodeId: options.target,
    payload,
  });
  if (controlled.isErr()) throw await runControlError(ctx, controlled.error, options.target);
  const result = controlled.value;
  if (result.type !== "signal") throw new Error(`Daemon returned '${result.type}' for signal control.`);
  ctx.setExitCode(writeControlResult({
    ok: true,
    phase: "control",
    message: "Signal consumed.",
    control: appliedControl(result, options.target),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, ctx));
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
  ctx.setExitCode(writeControlResult({
    ok: true,
    phase: "control",
    message: "Steer delivery: Interrupt & Continue. Current Turn fenced and draining; instruction queued for the same Session.",
    control: appliedControl(result, options.target),
    run: toRunRecord(result.run),
    ...(terminalRun(result.run) ? {} : { followRunId: result.run.id }),
  }, ctx));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, request: RunMutation): Promise<void> {
  if (request.type === "retry" && request.target.trim() === "") {
    throw usageError("--target must be a non-empty string.");
  }
  if (request.type === "cancel" && request.target === "") {
    throw usageError("--target must be a non-empty string.");
  }
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
  const agentOverrides = request.type === "fork" ? await parseAgents(request.agents, ctx.cwd) : undefined;
  const forkInput = request.type === "fork"
    ? await maybeNormalizeForkInput(ctx, runId, replacementInput, prepared)
    : undefined;
  const base = { requestId: daemonControlRequestId(), runId };
  const requestedTarget = "target" in request ? request.target : undefined;
  let intent: DaemonControlIntent;
  switch (request.type) {
    case "pause":
    case "resume":
      intent = { ...base, type: request.type };
      break;
    case "retry":
      intent = { ...base, type: "retry", target: request.target };
      break;
    case "cancel":
      intent = { ...base, type: "cancel", ...(request.target ? { target: request.target } : {}) };
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
    ctx.setExitCode(writeControlResult({
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
    }, ctx));
    return;
  }
  ctx.setExitCode(writeControlResult({
    ok: true,
    phase: "control",
    message: controlSuccessMessage(request.type),
    control,
    run,
    ...follow,
  }, ctx));
}

function writeControlResult(result: CliResult, ctx: RunsCommandContext): number {
  return writeResult(result, ctx, 0);
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
      return { type: "retry", state: "applied", runId: result.run.id, target: requestedTarget ?? result.target };
    case "cancel":
      return {
        type: result.type,
        state: "applied",
        runId: result.run.id,
        ...((requestedTarget ?? result.target) === undefined
          ? {}
          : { target: requestedTarget ?? result.target! }),
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
        delivery: result.delivery,
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
  if (normalized.isErr()) {
    if (isRuntimeReadFailure(normalized.error)) {
      throw controlError(runtimeReadFailureMessage(normalized.error), {
        errorCode: runtimeReadFailureCode(normalized.error),
        control: { type: "fork", runId },
      });
    }
    throw validationError(normalized.error.message);
  }
  return normalized.value;
}

function isRuntimeReadFailure(
  failure: ForkInputNormalizationFailure | RuntimeReadFailure,
): failure is RuntimeReadFailure {
  return typeof failure === "object"
    && failure !== null
    && "type" in failure
    && typeof failure.type === "string"
    && failure.type.startsWith("runtime-store-");
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
  const inspected = await readInspection(cwd, { kind: "target", runId, target, detail: "summary" });
  return inspected.isOk() && inspected.value.kind === "candidates"
    ? inspected.value
    : undefined;
}

function terminalRun(run: RunDetails): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "canceled";
}
