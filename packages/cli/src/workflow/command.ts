import type { Readable, Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { tryNormalizeWorkflowInput, tryValidateAgentOverrides, type AgentOverrideMap, type InspectionObservation, type PreparedRunWorkflow, type RunDetails } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { importError, runError, usageError, validationError, vizError } from "../presentation/errors.js";
import { RunInspectionTranscriptPresenter } from "../runs/follow.js";
import { discoverWorkflowCatalog, lookupWorkflowCatalogEntry, type WorkflowCatalogScope, type WorkflowCatalogScopeOptions } from "./catalog.js";
import { summarizeWorkflow, writeDiagnostics, writeResult } from "../presentation/output.js";
import { prepareWorkflowForCli, workflowPreparationCliError } from "./preparation.js";
import { parseAgents, parseInput } from "../presentation/json-input.js";
import {
  daemonAdmissionRequestId,
  sendDaemonSubmitAndObserve,
  type CliDaemonFailure,
} from "../daemon/client.js";
import { toRunRecord } from "../runs/record.js";
import { importWorkflowPackage } from "./import/index.js";
import { renderWorkflowTerminalViz } from "./terminal-viz.js";
import { supportsColor } from "../presentation/terminal-style.js";
import { canPrompt } from "../presentation/prompt.js";
import { pickWorkflowCatalogEntry } from "./catalog-picker.js";

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
    .option("--agents <json|file.json>", "validate inline JSON or a JSON file as submit-time agent overrides")
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
    .option("--agents <json|file.json>", "override declared agents with inline JSON or a JSON file")
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
  const agentOverrides = await parseAgents(options.agents, ctx.cwd);
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
  const agentOverrides = await parseAgents(options.agents, ctx.cwd);
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
  const until = options.follow
    ? "subject-terminal" as const
    : options.awaitDecision
      ? "decision-boundary" as const
      : "admitted" as const;
  const submitted = await submitWorkflowThroughDaemon(
    ctx,
    prepared,
    normalizedInput.value,
    admittedOverrides,
    until,
  );

  if (until === "admitted") {
    const result = {
      ok: true,
      phase: "run",
      diagnostics: prepared.ir.diagnostics,
      run: toRunRecord(submitted.run),
    } as const;
    ctx.setExitCode(writeResult(result, ctx, 0));
    return;
  }
  if (submitted.kind === "detached") {
    ctx.setExitCode(0);
    return;
  }
  ctx.setExitCode(submitted.run.status === "failed" || submitted.run.status === "canceled" ? 1 : 0);
}

type SubmitWorkflowOutcome =
  | { kind: "admitted"; run: RunDetails }
  | { kind: "closed"; run: RunDetails }
  | { kind: "detached"; run: RunDetails };

async function submitWorkflowThroughDaemon(
  ctx: WorkflowCommandContext,
  prepared: PreparedRunWorkflow,
  input: JsonValue,
  agentOverrides: AgentOverrideMap | undefined,
  until: "admitted" | "subject-terminal" | "decision-boundary",
): Promise<SubmitWorkflowOutcome> {
  const controller = new AbortController();
  let interruptCount = 0;
  let detachRequested = false;
  let hardInterrupted = false;
  let admitted: RunDetails | undefined;
  let closed: Extract<InspectionObservation, { kind: "closed" }> | undefined;
  let presenter: RunInspectionTranscriptPresenter | undefined;
  const onInterrupt = (): void => {
    interruptCount += 1;
    if (admitted !== undefined || interruptCount > 1) {
      hardInterrupted = admitted === undefined;
      detachRequested = admitted !== undefined;
      controller.abort();
      return;
    }
    detachRequested = true;
  };
  process.on("SIGINT", onInterrupt);
  const iterator = sendDaemonSubmitAndObserve(ctx.cwd, {
    requestId: daemonAdmissionRequestId(),
    prepared,
    input,
    ...(agentOverrides === undefined ? {} : { agentOverrides }),
    until,
  }, { signal: controller.signal })[Symbol.asyncIterator]();
  try {
    while (!controller.signal.aborted) {
      const next = await iterator.next();
      if (controller.signal.aborted) break;
      if (next.done) break;
      if (next.value.isErr()) throw daemonRunError(next.value.error);
      const frame = next.value.value;
      if (frame.kind === "admitted") {
        admitted = frame.run;
        if (until !== "admitted") {
          writeDiagnostics(ctx.stdout, prepared.ir.diagnostics, ctx.cwd);
          presenter = new RunInspectionTranscriptPresenter(ctx.stdout, admitted.id);
        }
        if (detachRequested) controller.abort();
        continue;
      }
      if (frame.kind === "observation") {
        presenter?.observation(frame.observation);
        if (frame.observation.kind === "closed") closed = frame.observation;
        continue;
      }
      throw runError(frame.error.message, { errorCode: frame.error.code });
    }
  } finally {
    controller.abort();
    process.off("SIGINT", onInterrupt);
    try {
      await iterator.return?.();
    } catch {}
  }

  if (hardInterrupted && admitted === undefined) {
    throw runError(
      "Run admission was interrupted before its durable outcome could be confirmed. Inspect recent runs before submitting again.",
      { errorCode: "ADMISSION_OUTCOME_UNKNOWN" },
    );
  }
  if (!admitted) {
    throw runError("Run submission ended before admission was confirmed.", { errorCode: "ADMISSION_OUTCOME_UNKNOWN" });
  }
  if (until === "admitted") return { kind: "admitted", run: admitted };
  if (detachRequested) {
    presenter?.block(`Detached from run ${admitted.id}. Background daemon continues running.\nInspect: acpus runs inspect ${admitted.id} --follow\n`);
    return { kind: "detached", run: admitted };
  }
  if (!closed) throw runError(
    `Runtime authority was lost after run '${admitted.id}' was admitted. The run remains durable. Run 'acpus runs inspect ${admitted.id} --follow'.`,
    { errorCode: "RUNTIME_AUTHORITY_LOST" },
  );
  return { kind: "closed", run: { ...admitted, status: closed.view.run.status } };
}

function daemonRunError(failure: CliDaemonFailure): Error {
  if (failure.type === "request-failed" && failure.code === "STORE_BUSY" && failure.runId === undefined) {
    return runError("Workspace runtime store is busy; retry the command or let the daemon finish current runtime writes.", { errorCode: "STORE_BUSY" });
  }
  const runId = failure.type === "request-failed"
    ? failure.runId
    : failure.type === "daemon-stream-protocol-failed" && failure.failure.outcome === "admitted"
      ? failure.failure.runId
      : undefined;
  const message = runId !== undefined
    ? `${failure.message} Run '${runId}' remains durable. Run 'acpus runs inspect ${runId} --follow'.`
    : failure.message;
  return runError(message, { errorCode: daemonFailureCode(failure) });
}

function daemonFailureCode(failure: CliDaemonFailure): string {
  return failure.type === "request-failed"
    ? failure.code
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
