import type { Writable } from "node:stream";
import { resolve } from "node:path";
import { Command } from "commander";
import { walkNodes } from "@acpus/core/ir";
import { DaemonRequestError, normalizeWorkflowInput, validateAgentOverrides, type AgentOverrideMap, type PreparedRunWorkflow, type RunDetails } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { runError, usageError, validationError } from "../errors.js";
import { followRun, parseFollowInterval } from "../run-follow.js";
import { discoverWorkflowCatalog, resolveWorkflowReference, showWorkflowCatalogEntry, type WorkflowCatalogScopeOptions } from "../catalog.js";
import { summarizeWorkflow, writeJsonLine, writeResult, type OutputFormat } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";
import { writeWorkflowInit } from "../workflow-init/write.js";
import { parseAgents, parseInput } from "./json.js";
import { sendDaemonAdmitRun } from "./daemon.js";

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
  interval?: string;
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

  const init = new Command("init")
    .exitOverride()
    .description("Create a TypeScript workflow module scaffold.");

  init.addCommand(new Command("file")
    .exitOverride()
    .description("Create a workflow module at a file path.")
    .argument("<file.ts>", "workflow module path")
    .action(async (file: string) => {
      await initWorkflow(ctx, {
        target: "file",
        destination: file,
      });
    }));

  init.addCommand(new Command("catalog")
    .exitOverride()
    .description("Create a project workflow catalog entry.")
    .argument("<name>", "workflow catalog name")
    .action(async (name: string) => {
      await initWorkflow(ctx, {
        target: "catalog",
        destination: name,
      });
    }));

  command.addCommand(init);

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
    .option("--interval <duration>", "refresh foreground run status (default: 1s, minimum: 250ms)")
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

async function initWorkflow(ctx: WorkflowCommandContext, options: Parameters<typeof writeWorkflowInit>[1]): Promise<void> {
  const result = await writeWorkflowInit(ctx.cwd, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "init",
    message: "Workflow initialized.",
    target: result.target,
    path: result.path,
  }, outputFormat(ctx), ctx, 0));
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
  if (options.background && options.interval !== undefined) throw usageError("--interval cannot be used with --background.");
  const intervalMs = parseFollowInterval(options.interval);
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
    const run = await admitWorkflowThroughDaemon(ctx.cwd, prepared, admittedInput, agentOverrides);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      sourceGraphDigest: prepared.sourceGraphDigest,
      run,
      followRunId: run.id,
      ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
    }, outputFormat(ctx), ctx, 0));
    return;
  }

  const admitted = await admitWorkflowThroughDaemon(ctx.cwd, prepared, admittedInput, agentOverrides);
  if (ctx.wantsJson) writeJsonLine(ctx.stdout, { ok: true, phase: "run", kind: "admitted", run: admitted, ...(resolved.catalog ? { catalog: resolved.catalog } : {}) });
  const outcome = await followRun(ctx.cwd, { runId: admitted.id, mode: "overview", intervalMs }, {
    phase: "run",
    wantsJson: ctx.wantsJson,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
  if (outcome.kind !== "done") {
    ctx.setExitCode(outcome.kind === "error" ? 1 : 0);
    return;
  }
  ctx.setExitCode(outcome.run.status === "failed" || outcome.run.status === "canceled" ? 1 : 0);
}

async function admitWorkflowThroughDaemon(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): Promise<RunDetails> {
  try {
    return await sendDaemonAdmitRun(cwd, { prepared, input, ...(agentOverrides === undefined ? {} : { agentOverrides }), start: true });
  } catch (error) {
    if (error instanceof DaemonRequestError && error.code === "STORE_BUSY") {
      throw runError("Workspace runtime store is busy; retry the command or let the daemon finish current runtime writes.", { errorCode: "STORE_BUSY" });
    }
    throw error;
  }
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
      nodeCount: Array.from(walkNodes(prepared.ir.root)).length,
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
