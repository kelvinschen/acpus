import type { Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/core";
import { CliError } from "../errors.js";
import { type CliResult, type OutputFormat, type RuntimeRunSummary, writeResult } from "../output.js";
import { preflightWorkflow } from "../preflight.js";
import { RuntimeEngine, RuntimeExecutionError, type StoredRun } from "../runtime/index.js";
import { readJsonOption } from "./json.js";

export type RuntimeCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type JsonOptions = {
  json?: boolean;
};

type InputOptions = JsonOptions & {
  input?: string | undefined;
  inputFile?: string | undefined;
};

type ExecuteOptions = JsonOptions & {
  agentStub?: boolean;
};

type ForkCommandOptions = InputOptions & ExecuteOptions & {
  workflow?: string | undefined;
  execute?: boolean;
};

export function createRuntimeCommands(ctx: RuntimeCommandContext): Command[] {
  return [
    createRunsCommand(ctx),
    createStatusCommand(ctx),
    createShowCommand(ctx),
    createPauseCommand(ctx),
    createResumeCommand(ctx),
    createRetryCommand(ctx),
    createSignalCommand(ctx),
    createReplayCommand(ctx),
    createForkCommand(ctx),
  ];
}

function createRunsCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "runs")
    .description("List durable workflow runs in this workspace.")
    .option("--limit <n>", "maximum runs to print", parseInteger, 50)
    .option("--json", "print a structured JSON result")
    .action(async (options: JsonOptions & { limit: number }) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const runs = engine.store.listRuns(options.limit).map(toRunSummary);
      emit(ctx, options, {
        ok: true,
        phase: "status",
        message: runs.length ? "Workflow runs." : "No workflow runs found.",
        runs,
      }, 0);
    }));
}

function createStatusCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "status")
    .description("Show a durable workflow run status.")
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: JsonOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = requireRun(engine, runId);
      emit(ctx, options, runResult(run, engine, { includeDetails: false, phase: "status", message: `Run ${run.status}.` }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function createShowCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "show")
    .description("Show a durable workflow run with node states and artifacts.")
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: JsonOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = requireRun(engine, runId);
      emit(ctx, options, runResult(run, engine, { includeDetails: true, phase: "status", message: `Run ${run.status}.` }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function createPauseCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "pause")
    .description("Pause a durable workflow run.")
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: JsonOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = engine.pauseRun(runId);
      emit(ctx, options, runResult(run, engine, { includeDetails: false, phase: "control", message: "Run paused." }), 0);
    }));
}

function createResumeCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "resume")
    .description("Resume a paused or awaiting durable workflow run.")
    .argument("<run-id>", "run id")
    .option("--agent-stub", "allow agent nodes without a configured local runner by returning schema-shaped defaults")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: ExecuteOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = await engine.resumeRun(runId, { agentStub: options.agentStub ?? false });
      emit(ctx, options, runResult(run, engine, { includeDetails: true, phase: "control", message: `Run ${run.status}.` }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function createRetryCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "retry")
    .description("Retry a failed run or failed subtree in place.")
    .argument("<run-id>", "run id")
    .option("--node <node-key>", "failed node key or subtree key to retry")
    .option("--agent-stub", "allow agent nodes without a configured local runner by returning schema-shaped defaults")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: ExecuteOptions & { node?: string | undefined }) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = await engine.retryRun(runId, options.node, { agentStub: options.agentStub ?? false });
      emit(ctx, options, runResult(run, engine, { includeDetails: true, phase: "control", message: `Run ${run.status}.` }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function createSignalCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "signal")
    .description("Deliver a durable signal payload and continue the run.")
    .argument("<run-id>", "run id")
    .argument("<node-id-or-key>", "signal node id or node instance key")
    .option("--input <json>", "signal payload JSON")
    .option("--input-file <path>", "read signal payload JSON from a file")
    .option("--agent-stub", "allow agent nodes without a configured local runner by returning schema-shaped defaults")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, nodeIdOrKey: string, options: InputOptions & ExecuteOptions) => withRuntimeErrors(async () => {
      const payload = await readJsonOption({ cwd: ctx.cwd, input: options.input, inputFile: options.inputFile, defaultValue: {} });
      const engine = RuntimeEngine.open(ctx.cwd);
      const run = await engine.signalRun(runId, nodeIdOrKey, payload, { agentStub: options.agentStub ?? false });
      emit(ctx, options, runResult(run, engine, { includeDetails: true, phase: "control", message: `Run ${run.status}.` }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function createReplayCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "replay")
    .description("Run read-only topology replay from recorded durable outputs.")
    .argument("<run-id>", "run id")
    .option("--json", "print a structured JSON result")
    .action(async (runId: string, options: JsonOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const replay = engine.replayRun(runId);
      emit(ctx, options, {
        ok: replay.ok,
        phase: "replay",
        message: replay.message,
        runId,
        replay,
      }, replay.ok ? 0 : 1);
    }));
}

function createForkCommand(ctx: RuntimeCommandContext): Command {
  return baseCommand(ctx, "fork")
    .description("Fork a durable workflow run into a new run and inherit matching completed work.")
    .argument("<run-id>", "source run id")
    .option("--workflow <workflow-module>", "compile a new workflow module for the fork")
    .option("--input <json>", "replacement workflow input JSON")
    .option("--input-file <path>", "read replacement workflow input JSON from a file")
    .option("--execute", "execute the fork after admission")
    .option("--agent-stub", "allow agent nodes without a configured local runner by returning schema-shaped defaults")
    .option("--json", "print a structured JSON result")
    .action(async (sourceRunId: string, options: ForkCommandOptions) => withRuntimeErrors(async () => {
      const engine = RuntimeEngine.open(ctx.cwd);
      const preflight = options.workflow ? await preflightWorkflow({ workflow: options.workflow, cwd: ctx.cwd }) : undefined;
      const input = (options.input || options.inputFile)
        ? await readJsonOption({ cwd: ctx.cwd, input: options.input, inputFile: options.inputFile })
        : undefined;
      const forked = await engine.forkRun(sourceRunId, {
        ...(preflight ? { ir: preflight.ir } : {}),
        ...(input !== undefined ? { input } : {}),
        metadata: preflight ? { forkWorkflow: options.workflow ?? null, preflightDir: preflight.artifact.dir } : null,
      });
      const run = options.execute ? await engine.execute(forked.runId, { agentStub: options.agentStub ?? false }) : forked;
      emit(ctx, options, runResult(run, engine, { includeDetails: true, phase: "fork", message: options.execute ? `Fork run ${run.status}.` : "Fork run admitted.", forkedFrom: sourceRunId }), run.status === "failed" || run.status === "cancelled" ? 1 : 0);
    }));
}

function baseCommand(ctx: RuntimeCommandContext, name: string): Command {
  return new Command(name)
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    });
}

function emit(ctx: RuntimeCommandContext, options: JsonOptions, result: CliResult, exitCode: number): void {
  const format: OutputFormat = options.json ? "json" : "text";
  ctx.setExitCode(writeResult(result, format, ctx, exitCode));
}

async function withRuntimeErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof RuntimeExecutionError) {
      throw new CliError(1, {
        ok: false,
        phase: "control",
        message: error.message,
        error: { code: error.code, details: error.details },
      });
    }
    throw error;
  }
}

function requireRun(engine: RuntimeEngine, runId: string): StoredRun {
  const run = engine.store.getRun(runId);
  if (!run) throw new RuntimeExecutionError("run_not_found", `Run '${runId}' was not found.`);
  return run;
}

function runResult(run: StoredRun, engine: RuntimeEngine, options: {
  includeDetails: boolean;
  phase: CliResult["phase"];
  message: string;
  forkedFrom?: string | undefined;
}): CliResult {
  const result: CliResult = {
    ok: run.status !== "failed" && run.status !== "cancelled",
    phase: options.phase,
    message: options.message,
    runId: run.runId,
    status: run.status,
    runDir: run.runDir,
    output: run.output,
    error: run.error,
    ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
  };
  if (options.includeDetails) {
    result.nodes = engine.store.listNodeStates(run.runId);
    result.artifacts = engine.store.listArtifacts(run.runId);
  }
  return result;
}

function toRunSummary(run: StoredRun): RuntimeRunSummary {
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    admittedAt: run.admittedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    runDir: run.runDir,
  };
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer.");
  return parsed;
}
