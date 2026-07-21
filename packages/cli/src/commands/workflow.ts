import type { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { walkNodes } from "@acpus/core/ir";
import { tryNormalizeWorkflowInput, tryValidateAgentOverrides, type AgentOverrideMap, type PreparedRunWorkflow, type RunDetails } from "@acpus/runtime";
import { staticExprShape, type JsonValue } from "@acpus/expression/ir";
import { importError, runError, usageError, validationError, vizError } from "../errors.js";
import { followRun, parseFollowInterval } from "../run-follow.js";
import { discoverWorkflowCatalog, resolveWorkflowReference, showWorkflowCatalogEntry, type WorkflowCatalogScope, type WorkflowCatalogScopeOptions } from "../catalog.js";
import { summarizeWorkflow, writeJsonLine, writeResult } from "../output.js";
import { prepareWorkflowForCli, workflowPreparationCliError } from "../workflow-preparation.js";
import { parseAgents, parseInput } from "./json.js";
import { sendDaemonAdmitRun, type CliDaemonFailure } from "./daemon.js";
import { toRunRecord } from "../run-record.js";
import { importWorkflowPackage } from "../workflow-import.js";
import { renderWorkflowTerminalViz } from "../workflow-terminal-viz.js";
import { outputFormatFor, withJsonOutput, type JsonOutputOptions } from "./output-option.js";

export type WorkflowCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type CatalogOutputOptions = WorkflowCatalogScopeOptions & JsonOutputOptions;

type WorkflowInputOptions = {
  input?: string;
  agents?: string;
} & CatalogOutputOptions;

type RunWorkflowOptions = WorkflowInputOptions & {
  background?: boolean;
  interval?: string;
};

type VizWorkflowOptions = WorkflowCatalogScopeOptions & {
  out?: string;
  force?: boolean;
};

type ImportWorkflowOptions = CatalogOutputOptions & {
  check?: boolean;
};

export function createWorkflowCommand(ctx: WorkflowCommandContext): Command {
  const command = new Command("workflow")
    .alias("wf")
    .exitOverride()
    .description("List, import, check, run, and visualize workflow definitions.");

  command.addCommand(withJsonOutput(new Command("list")
    .exitOverride()
    .description("List cataloged workflows.")
    .option("--project", "list project workflow catalog entries")
    .option("--global", "list global workflow catalog entries")
    ).action(async (options: CatalogOutputOptions) => {
      await listCatalog(ctx, options);
    }));

  command.addCommand(withJsonOutput(new Command("show")
    .exitOverride()
    .description("Show a cataloged workflow.")
    .argument("<name>", "workflow catalog name")
    .option("--project", "show a project workflow catalog entry")
    .option("--global", "show a global workflow catalog entry")
    ).action(async (name: string, options: CatalogOutputOptions) => {
      await showCatalog(ctx, name, options);
    }));

  command.addCommand(withJsonOutput(new Command("import")
    .exitOverride()
    .description("Import a workflow package snapshot into a local catalog.")
    .argument("<source>", "local workflow source or HTTP/HTTPS URL")
    .option("--project", "import into the project workflow catalog (default)")
    .option("--global", "import into the global workflow catalog")
    .option("--check", "fully prepare the workflow before committing (executes module top-level code)")
    ).action(async (source: string, options: ImportWorkflowOptions) => {
      await importWorkflow(ctx, source, options);
    }));

  command.addCommand(withJsonOutput(new Command("check")
    .exitOverride()
    .description("Typecheck, compile, and validate a workflow without mutating runtime state.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .option("--input <json|file.json>", "validate inline JSON or a JSON file as the workflow input")
    .option("--agents <json>", "validate submit-time agent overrides")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    ).action(async (workflow: string, options: WorkflowInputOptions) => {
      await checkWorkflow(ctx, workflow, options);
    }));

  command.addCommand(withJsonOutput(new Command("run")
    .exitOverride()
    .description("Prepare and run a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .option("--input <json|file.json>", "freeze inline JSON or a JSON file as the workflow input")
    .option("--agents <json>", "override declared agents for this run")
    .option("--background", "admit the run and execute it in the background")
    .option("--interval <duration>", "refresh foreground run status (default: 1s, minimum: 250ms)")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    ).action(async (workflow: string, options: RunWorkflowOptions) => {
      await runWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("viz")
    .exitOverride()
    .description("Render a static workflow visualization in the terminal or to an HTML file.")
    .argument("<workflow-module>", "workflow module path or catalog name")
    .option("--out <file.html>", "write the visualization as a self-contained HTML file")
    .option("--force", "overwrite the output file if it already exists")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: VizWorkflowOptions) => {
      await visualizeWorkflow(ctx, workflow, options);
    }));

  return command;
}

async function listCatalog(ctx: WorkflowCommandContext, options: CatalogOutputOptions): Promise<void> {
  const catalogEntries = await discoverWorkflowCatalog(ctx.cwd, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Workflow catalog listed.",
    catalogEntries,
  }, outputFormatFor(options), ctx, 0));
}

async function showCatalog(ctx: WorkflowCommandContext, name: string, options: CatalogOutputOptions): Promise<void> {
  const catalog = await showWorkflowCatalogEntry(ctx.cwd, name, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    message: "Workflow catalog entry shown.",
    catalog,
  }, outputFormatFor(options), ctx, 0));
}

async function importWorkflow(ctx: WorkflowCommandContext, source: string, options: ImportWorkflowOptions): Promise<void> {
  const scope = importScope(options);
  const imported = await importWorkflowPackage({
    cwd: ctx.cwd,
    source,
    scope,
    check: options.check ?? false,
  });
  imported.match(
    result => {
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "import",
        message: "Workflow imported.",
        catalog: result.catalog,
        checked: result.checked,
      }, outputFormatFor(options), ctx, 0));
    },
    failure => {
      if (failure.type === "preparation") throw workflowPreparationCliError(failure.failure);
      if (failure.type === "usage") throw usageError(failure.message);
      throw importError(failure.message, { errorCode: failure.errorCode });
    },
  );
}

function importScope(options: WorkflowCatalogScopeOptions): WorkflowCatalogScope {
  if (options.project && options.global) throw usageError("--project and --global are mutually exclusive.");
  return options.global ? "global" : "project";
}

async function checkWorkflow(ctx: WorkflowCommandContext, workflow: string, options: WorkflowInputOptions): Promise<void> {
  const input = options.input === undefined ? undefined : await parseInput(options.input, ctx.cwd);
  const agentOverrides = parseAgents(options.agents);
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  if (input !== undefined) {
    const normalized = tryNormalizeWorkflowInput(prepared.ir, input);
    if (normalized.isErr()) throw validationError(normalized.error.message);
  }
  const validatedOverrides = tryValidateAgentOverrides(prepared.ir, agentOverrides);
  if (validatedOverrides.isErr()) throw validationError(validatedOverrides.error.message);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "check",
    message: "Workflow check passed.",
    workflow: summarizeWorkflow(prepared.ir),
    diagnostics: prepared.ir.diagnostics,
    sourceGraphDigest: prepared.sourceGraphDigest,
    ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
  }, outputFormatFor(options), ctx, 0));
}

async function runWorkflow(ctx: WorkflowCommandContext, workflow: string, options: RunWorkflowOptions): Promise<void> {
  if (options.background && options.interval !== undefined) throw usageError("--interval cannot be used with --background.");
  const intervalMs = parseFollowInterval(options.interval);
  const input = options.input === undefined ? {} : await parseInput(options.input, ctx.cwd);
  const agentOverrides = parseAgents(options.agents);
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  const normalizedInput = tryNormalizeWorkflowInput(prepared.ir, input);
  if (normalizedInput.isErr()) throw validationError(normalizedInput.error.message);
  const validatedOverrides = tryValidateAgentOverrides(prepared.ir, agentOverrides);
  if (validatedOverrides.isErr()) throw validationError(validatedOverrides.error.message);
  const admittedInput = normalizedInput.value;
  const admittedOverrides = Object.keys(validatedOverrides.value).length === 0 ? undefined : validatedOverrides.value;

  if (options.background) {
    const admitted = await admitWorkflowThroughDaemon(ctx.cwd, prepared, admittedInput, admittedOverrides);
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      sourceGraphDigest: prepared.sourceGraphDigest,
      run: toRunRecord(admitted),
      followRunId: admitted.id,
      ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
    }, outputFormatFor(options), ctx, 0));
    return;
  }

  const admitted = await admitWorkflowThroughDaemon(ctx.cwd, prepared, admittedInput, admittedOverrides);
  const structured = outputFormatFor(options) === "json";
  if (structured) writeJsonLine(ctx.stdout, { schemaVersion: 1, ok: true, phase: "run", kind: "admitted", run: admitted, ...(resolved.catalog ? { catalog: resolved.catalog } : {}) });
  const outcome = await followRun(ctx.cwd, { runId: admitted.id, mode: "overview", intervalMs }, {
    phase: "run",
    format: structured ? "ndjson" : "text",
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
  const admitted = await sendDaemonAdmitRun(cwd, { prepared, input, ...(agentOverrides === undefined ? {} : { agentOverrides }) });
  if (admitted.isOk()) return admitted.value;
  if (admitted.error.type === "request-failed"
    && admitted.error.failure.type === "rejected"
    && admitted.error.failure.code === "STORE_BUSY") {
    throw runError("Workspace runtime store is busy; retry the command or let the daemon finish current runtime writes.", { errorCode: "STORE_BUSY" });
  }
  throw runError(admitted.error.message, { errorCode: daemonFailureCode(admitted.error) });
}

function daemonFailureCode(failure: CliDaemonFailure): string {
  return failure.type === "request-failed" && failure.failure.type === "rejected"
    ? failure.failure.code
    : failure.type.replaceAll("-", "_").toUpperCase();
}

async function visualizeWorkflow(ctx: WorkflowCommandContext, workflow: string, options: VizWorkflowOptions): Promise<void> {
  if (options.force && options.out === undefined) throw usageError("--force requires --out.");
  const resolved = await resolveWorkflowReference(ctx.cwd, workflow, options);
  const prepared = await prepareWorkflowForCli(resolved.workflow, ctx.cwd);
  if (options.out === undefined) {
    const visualization = renderWorkflowTerminalViz(prepared.ir, {
      color: (ctx.stdout as Writable & { isTTY?: boolean }).isTTY === true
        && process.env.NO_COLOR === undefined,
    });
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "viz",
      message: "Workflow visualization rendered.",
      visualization,
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      sourceGraphDigest: prepared.sourceGraphDigest,
      ...(resolved.catalog ? { catalog: resolved.catalog } : {}),
    }, "text", ctx, 0));
    return;
  }

  const { renderWorkflowVizHtml, workflowIrToWebGraph } = await import("@acpus/web");
  const outputPath = resolve(ctx.cwd, options.out);
  const graph = workflowIrToWebGraph(prepared.ir);
  const html = renderWorkflowVizHtml({
    graph,
    workflow: {
      name: prepared.ir.name,
      ...(prepared.ir.description === undefined ? {} : { description: prepared.ir.description }),
      irVersion: prepared.ir.irVersion,
      nodeCount: Array.from(walkNodes(prepared.ir.root)).length,
    },
    contract: {
      ...(prepared.ir.inputSchema === undefined ? {} : { inputSchema: prepared.ir.inputSchema }),
      output: prepared.ir.root.output,
      outputShape: staticExprShape(prepared.ir.root.output),
    },
    sourceGraphDigest: prepared.sourceGraphDigest,
  });
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    if (options.force) await writeFile(outputPath, html);
    else await writeFile(outputPath, html, { flag: "wx" });
  } catch (error) {
    const ioError = error as NodeJS.ErrnoException;
    if (!options.force && ioError.code === "EEXIST" && ioError.path === outputPath) {
      throw usageError(`Output file already exists: ${outputPath}`);
    }
    throw vizError(error instanceof Error ? error.message : String(error));
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
  }, "text", ctx, 0));
}
