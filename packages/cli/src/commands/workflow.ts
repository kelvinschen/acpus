import type { Writable } from "node:stream";
import { resolve } from "node:path";
import { Command } from "commander";
import type { WorkflowIR } from "@acpus/core/ir";
import { admitPreparedWorkflowRun, normalizeWorkflowInput, validateAgentOverrides, type RuntimeAdvanceResult } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { usageError, validationError } from "../errors.js";
import { discoverWorkflowCatalog, resolveWorkflowReference, showWorkflowCatalogEntry, type WorkflowCatalogScopeOptions } from "../catalog.js";
import { summarizeWorkflow, writeJsonLine, writeResult, type OutputFormat } from "../output.js";
import { formatRunObservationRow, formatRunStatusSurface, staticNodesForWorkflow, type RunStatusStaticNode } from "../run-status-surface.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { parseAgents, parseInput } from "./json.js";
import { sendDaemonObserveRun, sendDaemonStartRun } from "./daemon.js";

export type WorkflowCommandContext = {
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
  out?: string;
  force?: boolean;
} & WorkflowCatalogScopeOptions;

export function createWorkflowCommand(ctx: WorkflowCommandContext): Command {
  const command = new Command("workflow")
    .alias("wf")
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
    .option("--project", "list project workflow catalog entries")
    .option("--global", "list global workflow catalog entries")
    .action(async (options: WorkflowOptions) => {
      await listCatalog(ctx, options);
    }));

  command.addCommand(new Command("show")
    .exitOverride()
    .description("Show a cataloged workflow.")
    .argument("<name>", "workflow catalog name")
    .option("--project", "show a project workflow catalog entry")
    .option("--global", "show a global workflow catalog entry")
    .action(async (name: string, options: WorkflowOptions) => {
      await showCatalog(ctx, name, options);
    }));

  command.addCommand(new Command("check")
    .exitOverride()
    .description("Typecheck, compile, and validate a workflow without mutating runtime state.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .option("--input <json>", "validate this JSON value as the workflow input")
    .option("--agents <json>", "validate submit-time agent overrides")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: WorkflowOptions) => {
      await checkWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("run")
    .exitOverride()
    .description("Prepare and run a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .option("--input <json>", "freeze this JSON value as the workflow input")
    .option("--agents <json>", "override declared agents for this run")
    .option("--background", "admit the run and execute it in the background")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: WorkflowOptions) => {
      await runWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("viz")
    .exitOverride()
    .description("Generate a self-contained static workflow visualization HTML file.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .requiredOption("--out <file.html>", "write the visualization HTML to this file")
    .option("--force", "overwrite the output file if it already exists")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: WorkflowOptions) => {
      await visualizeWorkflow(ctx, workflow, options);
    }));

  return command;
}

async function listCatalog(ctx: WorkflowCommandContext, options: WorkflowOptions): Promise<void> {
  const catalogEntries = await discoverWorkflowCatalog(ctx.cwd, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Workflow catalog listed.",
    catalogEntries,
  }, outputFormat(ctx), ctx, 0));
}

async function showCatalog(ctx: WorkflowCommandContext, name: string, options: WorkflowOptions): Promise<void> {
  const catalog = await showWorkflowCatalogEntry(ctx.cwd, name, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Workflow catalog entry shown.",
    catalog,
  }, outputFormat(ctx), ctx, 0));
}

async function checkWorkflow(ctx: WorkflowCommandContext, workflow: string, options: WorkflowOptions): Promise<void> {
  const input = options.input === undefined ? undefined : parseInput(options.input);
  const agentOverrides = parseAgents(options.agents);
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  try {
    if (input !== undefined) normalizeWorkflowInput(prepared.ir, input);
    validateAgentOverrides(prepared.ir, agentOverrides);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error));
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "check",
    message: "Workflow check passed.",
    workflow: summarizeWorkflow(prepared.ir),
    diagnostics: prepared.ir.diagnostics,
    sourceGraphDigest: prepared.sourceGraphDigest,
    ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
  }, outputFormat(ctx), ctx, 0));
}

async function runWorkflow(ctx: WorkflowCommandContext, workflow: string, options: WorkflowOptions): Promise<void> {
  const input = parseInput(options.input);
  const agentOverrides = parseAgents(options.agents);
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  let admittedInput: JsonValue;
  try {
    admittedInput = normalizeWorkflowInput(prepared.ir, input);
    validateAgentOverrides(prepared.ir, agentOverrides);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error));
  }

  if (options.background) {
    const run = await admitPreparedWorkflowRun(ctx.cwd, prepared, admittedInput, agentOverrides);
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "canceled") await sendDaemonStartRun(ctx.cwd, run.id);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      sourceGraphDigest: prepared.sourceGraphDigest,
      run,
      ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
    }, outputFormat(ctx), ctx, 0));
    return;
  }

  const admitted = await admitPreparedWorkflowRun(ctx.cwd, prepared, admittedInput, agentOverrides);
  const staticNodes = staticNodesForWorkflow(prepared.ir);
  if (ctx.wantsJson) writeJsonLine(ctx.stdout, { ok: true, phase: "run", kind: "admitted", run: admitted, ...(resolved.catalog ? { catalog: resolved.catalog } : {}) });
  const seen = new Set([
    ...(admitted.dynamic?.nodeInstances.map(node => `node:${node.nodeKey}:${node.status}`) ?? []),
    ...(admitted.dynamic?.frames.map(frame => `frame:${frame.frameKey}:${frame.status}`) ?? []),
  ]);
  const detach = installDetachHandler(ctx, admitted.id);
  let advanced: RuntimeAdvanceResult;
  try {
    advanced = await sendDaemonObserveRun(ctx.cwd, admitted.id);
    writeRunObservations(ctx, seen, advanced.run, staticNodes);
  } finally {
    detach();
  }
  if (ctx.wantsJson) {
    writeJsonLine(ctx.stdout, {
      ok: advanced.status !== "failed" && advanced.status !== "canceled",
      phase: "run",
      kind: terminalKind(advanced.status),
      run: advanced.run,
      ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
    });
    ctx.setExitCode(advanced.status === "failed" || advanced.status === "canceled" ? 1 : 0);
    return;
  }
  ctx.stdout.write(formatRunStatusSurface(advanced.run, staticNodes));
  ctx.setExitCode(advanced.status === "failed" || advanced.status === "canceled" ? 1 : 0);
}

async function visualizeWorkflow(ctx: WorkflowCommandContext, workflow: string, options: WorkflowOptions): Promise<void> {
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  const { renderWorkflowVizHtml, workflowIrToWebGraph, writeWorkflowVizHtml } = await import("@acpus/web");
  const outputPath = resolve(ctx.cwd, options.out!);
  const graph = workflowIrToWebGraph(prepared.ir);
  const html = renderWorkflowVizHtml({
    graph,
    title: prepared.ir.name,
    workflow: {
      name: prepared.ir.name,
      ...(prepared.ir.description === undefined ? {} : { description: prepared.ir.description }),
      irVersion: prepared.ir.irVersion,
      nodeCount: countWorkflowNodes(prepared.ir.root),
    },
    contract: {
      ...(prepared.ir.inputSchema === undefined ? {} : { inputSchema: prepared.ir.inputSchema }),
      outputs: prepared.ir.outputs,
    },
    diagnostics: prepared.ir.diagnostics,
    sourceGraphDigest: prepared.sourceGraphDigest,
  });
  try {
    await writeWorkflowVizHtml(outputPath, html, { force: options.force === true });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "viz",
    message: "Workflow visualization written.",
    workflow: summarizeWorkflow(prepared.ir),
    diagnostics: prepared.ir.diagnostics,
    sourceGraphDigest: prepared.sourceGraphDigest,
    outputPath,
    ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
  }, outputFormat(ctx), ctx, 0));
}

function outputFormat(ctx: WorkflowCommandContext): OutputFormat {
  return ctx.wantsJson ? "json" : "text";
}

function countWorkflowNodes(scope: WorkflowIR["root"]): number {
  return scope.nodes.reduce((total, node) => {
    if (node.kind === "if") return total + 1 + countWorkflowNodes(node.then) + (node.else ? countWorkflowNodes(node.else) : 0);
    if (node.kind === "switch") return total + 1 + node.cases.reduce((sum, branch) => sum + countWorkflowNodes(branch.then), 0) + countWorkflowNodes(node.default);
    if (node.kind === "parallel") return total + 1 + Object.values(node.branches).reduce((sum, branch) => sum + countWorkflowNodes(branch.scope), 0);
    if (node.kind === "fanout") return total + 1 + countWorkflowNodes(node.do);
    if (node.kind === "loop") return total + 1 + countWorkflowNodes(node.do);
    return total + 1;
  }, 0);
}

function installDetachHandler(ctx: WorkflowCommandContext, runId: string): () => void {
  const handler = (): void => {
    if (ctx.wantsJson) {
      writeJsonLine(ctx.stdout, { ok: true, phase: "run", kind: "detached", run: { id: runId } });
    } else {
      ctx.stdout.write(`Detached from run ${runId}. Background daemon continues running.\n`);
    }
    process.exitCode = 0;
    process.exit(0);
  };
  process.once("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}

function writeRunObservations(ctx: WorkflowCommandContext, seen: Set<string>, run: RuntimeAdvanceResult["run"], staticNodes: readonly RunStatusStaticNode[]): void {
  for (const observation of runObservations(seen, run)) {
    if (ctx.wantsJson) writeJsonLine(ctx.stdout, observation);
    else ctx.stdout.write(`${formatRunObservationRow(run, observationTarget(observation), Date.now(), staticNodes) ?? `${observation.kind}: ${observationTarget(observation)} ${observation.status}`}\n`);
  }
}

type RunObservation = {
  ok: boolean;
  phase: "run";
  kind: string;
  runId: string;
  status: string;
  nodeKey?: string;
  frameKey?: string;
  nodeId?: string;
  reason?: string;
  error?: unknown;
};

function runObservations(seen: Set<string>, run: RuntimeAdvanceResult["run"]): RunObservation[] {
  const nodes = (run.dynamic?.nodeInstances ?? [])
    .filter(node => !seen.has(`node:${node.nodeKey}:${node.status}`))
    .slice(0, 100)
    .map((node): RunObservation => {
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
    .map((frame): RunObservation => {
      seen.add(`frame:${frame.frameKey}:${frame.status}`);
      return {
        ok: frame.status !== "failed",
        phase: "run",
        kind: nodeObservationKind(frame.status),
        runId: run.id,
        frameKey: frame.frameKey,
        ...(frame.nodeKey ? { nodeKey: frame.nodeKey } : {}),
        ...(frame.nodeId ? { nodeId: frame.nodeId } : {}),
        status: frame.status,
        ...(frame.terminalReason ? { reason: frame.terminalReason } : {}),
        ...(frame.error ? { error: frame.error } : {}),
      };
    });
  return [...nodes, ...frames];
}

function observationTarget(observation: RunObservation): string {
  return observation.nodeKey ?? observation.frameKey ?? observation.runId;
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
