import type { Readable, Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { tryNormalizeWorkflowInput, tryValidateAgentOverrides, type AgentOverrideMap, type PreparedRunWorkflow, type RunDetails } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { importError, runError, usageError, validationError, vizError } from "../errors.js";
import { followExitCode, followRun } from "../run-follow.js";
import { discoverWorkflowCatalog, lookupWorkflowCatalogEntry, type WorkflowCatalogScope, type WorkflowCatalogScopeOptions } from "../catalog.js";
import { summarizeWorkflow, writeDiagnostics, writeResult } from "../output.js";
import { prepareWorkflowForCli, workflowPreparationCliError } from "../workflow-preparation.js";
import { parseAgents, parseInput } from "./json.js";
import { sendDaemonAdmitRun, type CliDaemonFailure } from "./daemon.js";
import { toRunRecord } from "../run-record.js";
import { importWorkflowPackage } from "../workflow-import.js";
import { renderWorkflowTerminalViz } from "../workflow-terminal-viz.js";
import { supportsColor } from "../terminal-style.js";
import { canPrompt } from "./prompt-io.js";
import { pickWorkflowCatalogEntry } from "./workflow-catalog-picker.js";

export type WorkflowCommandContext = {
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type CatalogOptions = WorkflowCatalogScopeOptions;

type WorkflowInputOptions = {
  input?: string;
  agents?: string;
} & WorkflowCatalogScopeOptions;

type CheckWorkflowOptions = WorkflowInputOptions;

type RunWorkflowOptions = WorkflowInputOptions & {
  follow?: boolean;
  awaitDecision?: boolean;
};

type VizWorkflowOptions = WorkflowCatalogScopeOptions & {
  out?: string;
  force?: boolean;
};

type ImportWorkflowOptions = CatalogOptions & {
  check?: boolean;
};

export function createWorkflowCommand(ctx: WorkflowCommandContext): Command {
  const command = new Command("workflow")
    .alias("wf")
    .exitOverride()
    .description("Browse, import, check, run, and visualize workflow definitions.");

  command.addCommand(new Command("catalog")
    .exitOverride()
    .description("Browse the workflow catalog or inspect one entry.")
    .argument("[name]", "workflow catalog name; omit to browse the catalog")
    .option("--project", "use the project workflow catalog")
    .option("--global", "use the global workflow catalog")
    .action(async (name: string | undefined, options: CatalogOptions) => {
      await queryCatalog(ctx, name, options);
    }));

  command.addCommand(new Command("import")
    .exitOverride()
    .description("Import a workflow package snapshot into a local catalog.")
    .argument("<source>", "local workflow source or HTTP/HTTPS URL")
    .option("--project", "import into the project workflow catalog (default)")
    .option("--global", "import into the global workflow catalog")
    .option("--check", "fully prepare the workflow before committing (executes module top-level code)")
    .action(async (source: string, options: ImportWorkflowOptions) => {
      await importWorkflow(ctx, source, options);
    }));

  command.addCommand(new Command("check")
    .exitOverride()
    .description("Standalone workflow validation without admitting or executing a run.")
    .argument("<workflow-module>", "workflow module path, catalog name, or - for stdin")
    .option("--input <json|file.json>", "validate inline JSON or a JSON file as the workflow input")
    .option("--agents <json>", "validate submit-time agent overrides")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: CheckWorkflowOptions) => {
      await checkWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("run")
    .exitOverride()
    .description("Typecheck, compile, validate, and submit a workflow run.")
    .argument("<workflow-module>", "workflow module path, catalog name, or - for stdin (prefer a quoted heredoc)")
    .option("--input <json|file.json>", "freeze inline JSON or a JSON file as the workflow input")
    .option("--agents <json>", "override declared agents for this run")
    .option("--follow", "wait until the admitted run becomes terminal; Ctrl-C detaches")
    .option("--await-decision", "wait until the admitted run reaches an external decision boundary; Ctrl-C detaches")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: RunWorkflowOptions) => {
      await runWorkflow(ctx, workflow, options);
    }));

  command.addCommand(new Command("viz")
    .exitOverride()
    .description("Render a static workflow visualization in the terminal or to an HTML file.")
    .argument("<workflow-module>", "workflow module path, catalog name, or - for stdin")
    .option("--out <file.html>", "write the visualization as a self-contained HTML file")
    .option("--force", "overwrite the output file if it already exists")
    .option("--project", "resolve workflow name from the project catalog")
    .option("--global", "resolve workflow name from the global catalog")
    .action(async (workflow: string, options: VizWorkflowOptions) => {
      await visualizeWorkflow(ctx, workflow, options);
    }));

  return command;
}

async function queryCatalog(ctx: WorkflowCommandContext, name: string | undefined, options: CatalogOptions): Promise<void> {
  if (name !== undefined) {
    await writeCatalogEntryResult(ctx, name, options);
    return;
  }

  const catalogEntries = await discoverWorkflowCatalog(ctx.cwd, options);
  if (canPrompt(ctx)
    && catalogEntries.some(entry => entry.status === "available")) {
    const selected = await pickWorkflowCatalogEntry(catalogEntries, ctx);
    if (selected === undefined) throw usageError("Workflow selection cancelled.");
    await writeCatalogEntryResult(ctx, selected.name, {
      [selected.scope]: true,
    });
    return;
  }
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    catalogEntries,
  }, ctx, 0));
}

async function writeCatalogEntryResult(ctx: WorkflowCommandContext, name: string, options: CatalogOptions): Promise<void> {
  const catalog = await lookupWorkflowCatalogEntry(ctx.cwd, name, options);
  ctx.setExitCode(writeResult({
    ok: true,
    phase: "inspect",
    catalog,
  }, ctx, 0));
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
      ctx.setExitCode(writeResult(result.checked
        ? {
            ok: true,
            phase: "import",
            message: "Workflow imported.",
            catalog: result.catalog,
            checked: true,
            diagnostics: result.diagnostics,
            sourceGraphDigest: result.sourceGraphDigest,
          }
        : {
            ok: true,
            phase: "import",
            message: "Workflow imported.",
            catalog: result.catalog,
            checked: false,
          }, ctx, 0));
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

async function checkWorkflow(ctx: WorkflowCommandContext, workflow: string, options: CheckWorkflowOptions): Promise<void> {
  const input = options.input === undefined ? undefined : await parseInput(options.input, ctx.cwd);
  const agentOverrides = parseAgents(options.agents);
  const { prepared, catalog } = await prepareWorkflowForCli({
    workspaceDir: ctx.cwd,
    workflow,
    stdin: ctx.stdin,
    ...(options.project ? { project: true } : {}),
    ...(options.global ? { global: true } : {}),
  });
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
    ...(catalog ? { catalog } : {}),
  }, ctx, 0));
}

async function runWorkflow(ctx: WorkflowCommandContext, workflow: string, options: RunWorkflowOptions): Promise<void> {
  if (options.follow && options.awaitDecision) throw usageError("--follow and --await-decision are mutually exclusive.");
  const input = options.input === undefined ? {} : await parseInput(options.input, ctx.cwd);
  const agentOverrides = parseAgents(options.agents);
  const { prepared } = await prepareWorkflowForCli({
    workspaceDir: ctx.cwd,
    workflow,
    stdin: ctx.stdin,
    ...(options.project ? { project: true } : {}),
    ...(options.global ? { global: true } : {}),
  });
  const normalizedInput = tryNormalizeWorkflowInput(prepared.ir, input);
  if (normalizedInput.isErr()) throw validationError(normalizedInput.error.message);
  const validatedOverrides = tryValidateAgentOverrides(prepared.ir, agentOverrides);
  if (validatedOverrides.isErr()) throw validationError(validatedOverrides.error.message);
  const admittedOverrides = Object.keys(validatedOverrides.value).length === 0 ? undefined : validatedOverrides.value;
  const admitted = await admitWorkflowThroughDaemon(ctx.cwd, prepared, normalizedInput.value, admittedOverrides);

  if (!options.follow && !options.awaitDecision) {
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "run",
      diagnostics: prepared.ir.diagnostics,
      run: toRunRecord(admitted),
    }, ctx, 0));
    return;
  }

  writeDiagnostics(ctx.stdout, prepared.ir.diagnostics, ctx.cwd);
  const outcome = await followRun(ctx.cwd, {
    kind: "run",
    runId: admitted.id,
  }, {
    until: options.follow ? "subject-terminal" : "decision-boundary",
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
  if (outcome.kind !== "closed") {
    ctx.setExitCode(followExitCode(outcome));
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
  const { prepared, catalog } = await prepareWorkflowForCli({
    workspaceDir: ctx.cwd,
    workflow,
    stdin: ctx.stdin,
    ...(options.project ? { project: true } : {}),
    ...(options.global ? { global: true } : {}),
  });
  if (options.out === undefined) {
    const visualization = renderWorkflowTerminalViz(prepared.ir, {
      color: supportsColor(ctx.stdout),
    });
    ctx.setExitCode(writeResult({
      ok: true,
      phase: "viz",
      message: "Workflow visualization rendered.",
      visualization,
      workflow: summarizeWorkflow(prepared.ir),
      diagnostics: prepared.ir.diagnostics,
      ...(catalog ? { catalog } : {}),
    }, ctx, 0));
    return;
  }

  const { renderWorkflowVizHtml } = await import("@acpus/web");
  const outputPath = resolve(ctx.cwd, options.out);
  const html = renderWorkflowVizHtml({
    ir: prepared.ir,
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
    outputPath,
    ...(catalog ? { catalog } : {}),
  }, ctx, 0));
}
