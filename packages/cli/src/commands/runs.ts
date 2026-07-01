import type { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { AgentOverrideMap } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { getRun, listRuns, mutateRun as mutateRuntimeRun, normalizeForkInput, queueSupervisorShutdown, replayRun as replayRuntimeRun, signalRun as signalRuntimeRun } from "@acpus/runtime";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { usageError, validationError, notFoundError } from "../errors.js";
import { writeResult, type OutputFormat } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";

export type RunsCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type RunsCommandOptions = {
  json?: boolean;
  node?: string;
  payload?: string;
  input?: string;
  workflow?: string;
  agents?: string;
  background?: boolean;
  prepared?: PreparedWorkflow;
};

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
    .description("Inspect durable runtime runs.");

  command.addCommand(new Command("list")
    .exitOverride()
    .option("--json", "print a structured JSON result")
    .action(async (options: RunsCommandOptions) => {
      const format: OutputFormat = options.json ? "json" : "text";
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "inspect",
        message: "Runs listed.",
        runs: await listRuns(ctx.cwd),
      }, format, ctx, 0));
    }));

  const show = new Command("show")
    .exitOverride()
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await showRun(ctx, runId, options);
    });
  command.addCommand(show);

  command.addCommand(new Command("status")
    .exitOverride()
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await showRun(ctx, runId, options);
    }));

  for (const name of ["pause", "resume", "retry"] as const) {
    const control = new Command(name)
      .exitOverride()
      .argument("<run-id>", "run id")
      .option("--json", "print a structured JSON result")
      .action(async (runId: string, options: RunsCommandOptions) => {
        await mutateRun(ctx, runId, options, name);
      });
    if (name === "retry") control.option("--node <node-id>", "retry only a failed node");
    command.addCommand(control);
  }

  command.addCommand(new Command("fork")
    .exitOverride()
    .argument("<run-id>", "run id")
    .option("--workflow <workflow-module>", "fork with a new workflow module")
    .option("--input <json>", "override workflow input for the fork")
    .option("--agents <json>", "override inherited agents for the fork")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await mutateRun(ctx, runId, options, "fork");
    }));

  command.addCommand(new Command("signal")
    .exitOverride()
    .argument("<run-id>", "run id")
    .requiredOption("--node <node-id>", "signal node id")
    .requiredOption("--payload <json>", "signal payload JSON")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await signalRun(ctx, runId, options);
    }));

  command.addCommand(new Command("replay")
    .exitOverride()
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: RunsCommandOptions) => {
      await replayRun(ctx, runId, options);
    }));

  command.addCommand(new Command("supervise")
    .exitOverride()
    .option("--background", "start the workspace supervisor in the background")
    .option("--json", "print a structured JSON result")
    .action(async (options: RunsCommandOptions) => {
      await supervise(ctx, options);
    }));

  command.addCommand(new Command("shutdown")
    .exitOverride()
    .option("--json", "print a structured JSON result")
    .action(async (options: RunsCommandOptions) => {
      await shutdownSupervisor(ctx, options);
    }));

  return command;
}

async function supervise(ctx: RunsCommandContext, options: RunsCommandOptions): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const child = spawn(process.execPath, supervisorEntryArgs(ctx.cwd), {
    cwd: ctx.cwd,
    detached: Boolean(options.background),
    stdio: options.background ? "ignore" : "inherit",
  });
  if (options.background) child.unref();
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Supervisor started.",
  }, format, ctx, 0));
}

function supervisorEntryArgs(cwd: string): string[] {
  const isSourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`../supervisor-entry.${isSourceMode ? "ts" : "js"}`, import.meta.url));
  return isSourceMode
    ? ["--conditions=development", "--import", "tsx", entry, cwd]
    : [entry, cwd];
}

async function replayRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const replay = await replayRuntimeRun(ctx.cwd, runId);
  if (!replay) throw notFoundError(`Run '${runId}' was not found.`);
  ctx.setExitCode(writeResult({
    ok: replay.ok,
    phase: "inspect",
    message: replay.ok ? "Replay matched." : "Replay did not match.",
    replay,
  }, format, ctx, replay.ok ? 0 : 1));
}

async function shutdownSupervisor(ctx: RunsCommandContext, options: RunsCommandOptions): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const command = await queueSupervisorShutdown(ctx.cwd);
  if (!command) throw notFoundError("No runtime supervisor was found.");
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Supervisor shutdown command queued.",
    command,
  }, format, ctx, 0));
}

async function signalRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const payload = parsePayload(options.payload);
  let result: Awaited<ReturnType<typeof signalRuntimeRun>>;
  try {
    result = await signalRuntimeRun(ctx.cwd, runId, options.node!, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Signal node '${options.node}' was not found.`) throw notFoundError(message);
    throw validationError(message);
  }
  if (!result) throw notFoundError(`Run '${runId}' was not found.`);
  const advanced = result.advanced;
  ctx.setExitCode(writeResult({
    ok: advanced?.status !== "failed",
    phase: "inspect",
    message: advanced?.status === "failed" ? advanced.message : "Signal accepted.",
    run: result.run,
  }, format, ctx, advanced?.status === "failed" ? 1 : 0));
}

function parsePayload(raw: string | undefined): JsonValue {
  if (!raw) throw usageError("--payload is required.");
  return parseJsonOption(raw, "--payload");
}

function parseJsonOption(raw: string, name: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw usageError(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonValue(value)) throw usageError(`${name} must be JSON-serializable.`);
  return value;
}

function parseAgents(raw: string | undefined): AgentOverrideMap | undefined {
  if (raw === undefined) return undefined;
  const value = parseJsonOption(raw, "--agents");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--agents must be a JSON object.");
  return value as AgentOverrideMap;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

async function showRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const run = await getRun(ctx.cwd, runId);
  if (!run) throw notFoundError(`Run '${runId}' was not found.`);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Run inspected.",
    run,
  }, format, ctx, 0));
}

async function mutateRun(ctx: RunsCommandContext, runId: string, options: RunsCommandOptions, action: "pause" | "resume" | "retry" | "fork"): Promise<void> {
  const format: OutputFormat = options.json ? "json" : "text";
  const prepared = action === "fork" && options.workflow ? await prepareWorkflowForCli(options.workflow, ctx.cwd) : options.prepared;
  const agentOverrides = action === "fork" ? parseAgents(options.agents) : undefined;
  let forkInput: JsonValue | undefined;
  if (action === "fork" && options.input !== undefined) {
    const rawInput = parseJsonOption(options.input, "--input");
    try {
      forkInput = await normalizeForkInput(ctx.cwd, runId, rawInput, prepared);
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : String(error));
    }
  } else if (action === "fork" && prepared) {
    try {
      forkInput = await normalizeForkInput(ctx.cwd, runId, undefined, prepared);
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : String(error));
    }
  }
  if (action === "fork" && (options.input !== undefined || prepared) && forkInput === undefined) throw notFoundError(`Run '${runId}' was not found.`);
  let result: Awaited<ReturnType<typeof mutateRuntimeRun>>;
  try {
    result = await mutateRuntimeRun(ctx.cwd, runId, action, {
      ...(options.node ? { node: options.node } : {}),
      ...(prepared ? { prepared } : {}),
      ...(forkInput !== undefined ? { input: forkInput } : {}),
      ...(agentOverrides !== undefined ? { agentOverrides } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Run '${runId}' was not found.`) throw notFoundError(message);
    throw validationError(message);
  }
  if (!result) throw notFoundError(`Run '${runId}' was not found.`);
  const advanced = result.advanced;
  if (advanced?.status === "failed") {
    ctx.setExitCode(writeResult({
      ok: false,
      phase: "inspect",
      message: advanced.message,
      run: result.run,
    }, format, ctx, 1));
    return;
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: action === "fork" ? "Run forked." : `Run ${action}d.`,
    run: result.run,
  }, format, ctx, 0));
}
