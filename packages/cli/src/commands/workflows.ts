import type { Writable } from "node:stream";
import { Command } from "commander";
import { advanceWorkflowRun, admitWorkflowRunOnly, normalizeWorkflowInput, releaseWorkflowRunOwner, validateAgentOverrides, type RuntimeAdvanceResult } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { writePreflightArtifact } from "@acpus/workflow-compiler";
import { validationError } from "../errors.js";
import { summarizeWorkflow, writeJsonLine, writeResult, type OutputFormat } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { parseAgents, parseInput } from "./json.js";
import { ensureSupervisorRunning } from "./supervisor.js";

export type WorkflowsCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type WorkflowOptions = {
  input?: string;
  agents?: string;
  background?: boolean;
};

export function createWorkflowsCommand(ctx: WorkflowsCommandContext): Command {
  const command = new Command("workflows")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Check, run, and inspect workflow definitions.");

  command.addCommand(new Command("list")
    .exitOverride()
    .description("List cataloged workflows.")
    .action(() => catalogPlaceholder(ctx)));

  command.addCommand(new Command("show")
    .exitOverride()
    .description("Show a cataloged workflow.")
    .argument("<name-or-ref>", "workflow catalog name or reference")
    .action(() => catalogPlaceholder(ctx)));

  command.addCommand(new Command("check")
    .exitOverride()
    .description("Typecheck, compile, validate, and write a preflight artifact.")
    .argument("<workflow-module>", "workflow module path")
    .option("--input <json>", "validate this JSON value as the workflow input")
    .option("--agents <json>", "validate submit-time agent overrides")
    .action(async (workflow: string, options: WorkflowOptions) => {
      await checkWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("run")
    .exitOverride()
    .description("Prepare and run a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path")
    .option("--input <json>", "freeze this JSON value as the workflow input")
    .option("--agents <json>", "override declared agents for this run")
    .option("--background", "admit the run and execute it in the background")
    .action(async (workflow: string, options: WorkflowOptions) => {
      await runWorkflow(ctx, workflow, options);
    }));

  return command;
}

function catalogPlaceholder(ctx: WorkflowsCommandContext): void {
  ctx.setExitCode(writeResult({
    ok: false,
    phase: "inspect",
    message: "Workflow catalog discovery is not implemented in this version.",
  }, ctx.wantsJson ? "json" : "text", ctx, 1));
}

async function checkWorkflow(ctx: WorkflowsCommandContext, workflow: string, options: WorkflowOptions): Promise<void> {
  const input = options.input === undefined ? undefined : parseInput(options.input);
  const agentOverrides = parseAgents(options.agents);
  const prepared = await prepareWorkflowForCli(workflow, ctx.cwd);
  try {
    if (input !== undefined) normalizeWorkflowInput(prepared.ir, input);
    validateAgentOverrides(prepared.ir, agentOverrides);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error));
  }
  const artifact = await writePreflightArtifact(prepared, ctx.cwd);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "check",
    message: "Workflow check passed.",
    workflow: summarizeWorkflow(prepared.ir),
    diagnostics: prepared.ir.diagnostics,
    preflightDir: artifact.dir,
    irDigest: prepared.irDigest,
    sourceGraphDigest: prepared.sourceGraphDigest,
  }, ctx.wantsJson ? "json" : "text", ctx, 0));
}

async function runWorkflow(ctx: WorkflowsCommandContext, workflow: string, options: WorkflowOptions): Promise<void> {
  const input = parseInput(options.input);
  const agentOverrides = parseAgents(options.agents);
  const prepared = await prepareWorkflowForCli(workflow, ctx.cwd);
  let admittedInput: JsonValue;
  try {
    admittedInput = normalizeWorkflowInput(prepared.ir, input);
    validateAgentOverrides(prepared.ir, agentOverrides);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error));
  }

  if (options.background) {
    const run = await admitWorkflowRunOnly(ctx.cwd, prepared, admittedInput, agentOverrides);
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "canceled") ensureSupervisorRunning(ctx.cwd);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      irDigest: prepared.irDigest,
      sourceGraphDigest: prepared.sourceGraphDigest,
      run,
    }, ctx.wantsJson ? "json" : "text", ctx, 0));
    return;
  }

  const admitted = await admitWorkflowRunOnly(ctx.cwd, prepared, admittedInput, agentOverrides);
  if (ctx.wantsJson) writeJsonLine(ctx.stdout, { ok: true, phase: "run", kind: "admitted", run: admitted });
  const ownerId = `foreground:${process.pid}`;
  const detach = installDetachHandler(ctx, admitted.id, ownerId);
  const seen = new Set([
    ...(admitted.dynamic?.nodeInstances.map(node => `node:${node.nodeKey}:${node.status}`) ?? []),
    ...(admitted.dynamic?.frames.map(frame => `frame:${frame.frameKey}:${frame.status}`) ?? []),
  ]);
  let advanced: RuntimeAdvanceResult;
  try {
    advanced = await advanceWorkflowRun(ctx.cwd, admitted.id, ownerId, run => {
      if (ctx.wantsJson) writeRunObservations(ctx, seen, run);
    });
  } finally {
    detach();
  }
  if (ctx.wantsJson) {
    writeJsonLine(ctx.stdout, {
      ok: advanced.status !== "failed",
      phase: "run",
      kind: terminalKind(advanced.status),
      run: advanced.run,
    });
    ctx.setExitCode(advanced.status === "failed" ? 1 : 0);
    return;
  }
  ctx.setExitCode(writeResult({
    ok: advanced.status !== "failed",
    phase: "run",
    message: runMessage(advanced),
    workflow: summarizeWorkflow(prepared.ir),
    diagnostics: prepared.ir.diagnostics,
    irDigest: prepared.irDigest,
    sourceGraphDigest: prepared.sourceGraphDigest,
    run: advanced.run,
  }, "text", ctx, advanced.status === "failed" ? 1 : 0));
}

function installDetachHandler(ctx: WorkflowsCommandContext, runId: string, ownerId: string): () => void {
  const handler = (): void => {
    void releaseWorkflowRunOwner(ctx.cwd, runId, ownerId).finally(() => {
      ensureSupervisorRunning(ctx.cwd);
      if (ctx.wantsJson) {
        writeJsonLine(ctx.stdout, { ok: true, phase: "run", kind: "detached", run: { id: runId } });
      } else {
        ctx.stdout.write(`Detached from run ${runId}. Background supervisor started.\n`);
      }
      process.exitCode = 0;
      process.exit(0);
    });
  };
  process.once("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}

function writeRunObservations(ctx: WorkflowsCommandContext, seen: Set<string>, run: RuntimeAdvanceResult["run"]): void {
  for (const observation of runObservations(seen, run)) writeJsonLine(ctx.stdout, observation);
}

function runObservations(seen: Set<string>, run: RuntimeAdvanceResult["run"]): unknown[] {
  const nodes = (run.dynamic?.nodeInstances ?? [])
    .filter(node => !seen.has(`node:${node.nodeKey}:${node.status}`))
    .slice(0, 100)
    .map(node => {
      seen.add(`node:${node.nodeKey}:${node.status}`);
      return {
        ok: node.status !== "failed",
        phase: "run",
        kind: nodeObservationKind(node.status),
        runId: run.id,
        nodeKey: node.nodeKey,
        nodeId: node.nodeId,
        status: node.status,
        ...(node.statusReason ? { reason: node.statusReason } : {}),
        ...(node.error ? { error: node.error } : {}),
      };
    });
  const frames = (run.dynamic?.frames ?? [])
    .filter(frame => frame.nodeId && !seen.has(`frame:${frame.frameKey}:${frame.status}`))
    .slice(0, Math.max(0, 100 - nodes.length))
    .map(frame => {
      seen.add(`frame:${frame.frameKey}:${frame.status}`);
      return {
        ok: frame.status !== "failed",
        phase: "run",
        kind: nodeObservationKind(frame.status),
        runId: run.id,
        frameKey: frame.frameKey,
        ...(frame.nodeKey ? { nodeKey: frame.nodeKey } : {}),
        nodeId: frame.nodeId,
        status: frame.status,
        ...(frame.terminalReason ? { reason: frame.terminalReason } : {}),
        ...(frame.error ? { error: frame.error } : {}),
      };
    });
  return [...nodes, ...frames];
}

function nodeObservationKind(status: string): string {
  if (status === "completed") return "node completed";
  if (status === "failed") return "node failed";
  if (status === "awaiting") return "node awaiting signal";
  if (status === "cancelled") return "node cancelled";
  if (status === "running") return "node started";
  return "node updated";
}

function terminalKind(status: string): string {
  if (status === "awaiting") return "node awaiting signal";
  if (status === "paused") return "run paused";
  return status === "failed" || status === "completed" || status === "canceled" ? "terminal summary" : "run idle";
}

function runMessage(result: RuntimeAdvanceResult): string {
  if (result.status === "completed") return "Run completed.";
  if (result.status === "failed") return result.message;
  if (result.status === "awaiting") return `Run awaiting signal '${result.nodeKey}'. Use: acpus runs signal ${result.run.id} --target ${result.nodeKey} --payload '<json>'`;
  if (result.status === "paused") return `Run paused. Use: acpus runs resume ${result.run.id}`;
  if (result.status === "canceled") return "Run canceled.";
  if (result.status === "lease_lost") return "Run admitted but scheduler ownership was busy.";
  return "Run admitted.";
}
