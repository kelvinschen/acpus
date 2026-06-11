#!/usr/bin/env node
import { compileWorkflow, lintWorkflow, workflowSourcePolicy } from "@acpus/core";
import { Command } from "commander";
import { relative } from "node:path";
import {
  findWorkflowCatalogEntry,
  listWorkflowCatalog,
  looksLikeWorkflowPath,
  resolveWorkflowPath,
  resolveWorkflowTarget,
  type WorkflowCatalogEntry
} from "./catalog.js";
import { parseInput, readTextFile } from "./io.js";
import { printCompile, printError, printLint } from "./output.js";
import { ensureSupervisor, EXIT_SUPERVISOR_ERROR, isSupervisorConnectionError } from "./supervisor.js";
import { followRun } from "./follow.js";
import { formatRunShow } from "./runs-show.js";
import type { RunCleanResult, RunStatus } from "@acpus/runtime";
import { ForkRejectedError } from "@acpus/runtime";

const EXIT_DSL_STATIC_ERROR = 10;
const EXIT_RUNTIME_ERROR = 20;
const EXIT_FORK_REJECTED = 21;
const EXIT_USER_CANCEL = 2;
const EXIT_CLI_ERROR = 1;

const program = new Command();

program
  .name("acpus")
  .description("Local durable ACP workflow runner")
  .version("0.1.0");

const workflows = new Command("workflows")
  .alias("wf")
  .description("discover, inspect, lint, and run Workflow Specs");

workflows
  .command("list")
  .option("--json", "write JSON output")
  .action((options: { json?: boolean }) => {
    try {
      const entries = listWorkflowCatalog();
      if (options.json) {
        console.log(JSON.stringify(entries));
        return;
      }
      printWorkflowList(entries);
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = EXIT_RUNTIME_ERROR;
    }
  });

workflows
  .command("show")
  .argument("<refOrName>", "Workflow Catalog ref or unique workflow name")
  .option("--json", "write JSON output")
  .action((refOrName: string, options: { json?: boolean }) => {
    try {
      const entry = findWorkflowCatalogEntry(refOrName);
      if (options.json) {
        console.log(JSON.stringify(entry));
        return;
      }
      printWorkflowDetails(entry);
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = EXIT_RUNTIME_ERROR;
    }
  });

workflows
  .command("lint")
  .argument("<refOrPath>", "Workflow Catalog ref/name or workflow YAML spec path")
  .option("--strict", "treat warnings as errors")
  .option("--json", "write JSON output")
  .option("--quiet", "only write final output")
  .action((refOrPath: string, options: { strict?: boolean; json?: boolean; quiet?: boolean }) => {
    try {
      const sourcePath = resolveLintTarget(refOrPath);
      const result = lintWorkflow(readTextFile(sourcePath), {
        sourcePath,
        strict: options.strict,
        includeResolver: createWorkspaceIncludeResolver()
      });
      printLint(result, options);
      process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = EXIT_RUNTIME_ERROR;
    }
  });

workflows
  .command("run")
  .argument("<refOrPath>", "Workflow Catalog ref/name or workflow YAML spec path")
  .option("--dry-run", "compile to IR and print schedule without execution")
  .option("--input <value>", "inline JSON or path to YAML/JSON input object")
  .option("--background", "submit and return immediately (no follow)")
  .option("--visualize", "submit and open TUI visualizer")
  .option("--json", "write JSONL observations (follow mode) or JSON (background)")
  .option("--quiet", "only write final output")
  .action(async (
    refOrPath: string,
    options: { dryRun?: boolean; input?: string; background?: boolean; visualize?: boolean; json?: boolean; quiet?: boolean }
  ) => {
    if (options.background && options.visualize) {
      printError("--background and --visualize are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }
    if (options.visualize && options.json) {
      printError("--visualize and --json are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }

    try {
      const target = resolveWorkflowTarget(refOrPath);
      const parsedInput = parseInput(options.input);

      if (options.dryRun) {
        const result = compileWorkflow(target.source, {
          sourcePath: target.sourcePath,
          includeResolver: createWorkspaceIncludeResolver()
        });
        const output = parsedInput === undefined || !result.ir
          ? result
          : { ...result, ir: { ...result.ir, runtimeInput: parsedInput } };
        printCompile(output, options);
        process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
        return;
      }

      const client = await ensureSupervisor();
      const runState = await client.startRun(target.source, parsedInput, target.sourcePath, target.workflowRef);

      if (options.background) {
        if (options.json) {
          console.log(JSON.stringify(runState));
        } else if (!options.quiet) {
          console.log(`Run ${runState.runId} started: ${runState.workflowName}`);
          if (runState.workflowRef) console.log(`Workflow: ${runState.workflowRef}`);
          console.log(`Status: ${runState.status}`);
        }
        process.exitCode = 0;
        return;
      }

      if (options.visualize) {
        const { runTui } = await import("@acpus/tui");
        await runTui({ runId: runState.runId, endpoint: (client as any).baseUrl as string });
        process.exitCode = 0;
        return;
      }

      const terminalStatus = await followRun(client, runState.runId, { json: options.json });
      process.exitCode = exitCodeForRunStatus(terminalStatus);
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program.addCommand(workflows);

const runs = new Command("runs")
  .description("list, inspect, clean, visualize, and control Workflow Runs");

runs
  .command("list")
  .option("--json", "write JSON output")
  .action(async (options: { json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const runList = await client.listRuns();
      if (options.json) {
        console.log(JSON.stringify(runList));
      } else if (runList.length === 0) {
        console.log("No runs found.");
      } else {
        for (const run of runList) {
          const source = run.workflowRef ?? run.workflowSourcePath ?? "-";
          const lineageNote = run.lineage ? `  forked from ${run.lineage.sourceRunId}` : "";
          console.log(`${run.runId}  ${run.workflowName}  ${run.status}  ${run.updatedAt}  ${source}${lineageNote}`);
        }
      }
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("show")
  .argument("<runId>", "run ID to inspect")
  .option("--json", "write JSON output")
  .action(async (runId: string, options: { json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const run = await client.getRun(runId);
      if (options.json) {
        console.log(JSON.stringify(run));
        return;
      }
      console.log(await formatRunShow(run, client));
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("clean")
  .option("--dry-run", "report deletions without removing Run directories")
  .option("--json", "write JSON output")
  .action(async (options: { dryRun?: boolean; json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const result = await client.cleanRuns({ dryRun: options.dryRun });
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        printCleanResult(result);
      }
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("visualize")
  .argument("[runId]", "run ID to observe (omit to pick from a list)")
  .option("--serve [listen]", "serve a read-only browser visualizer, optionally on <port> or <host:port>")
  .description("open a TUI visualizer to observe and control a running workflow")
  .action(async (runId: string | undefined, options: { serve?: boolean | string }) => {
    try {
      if (options.serve !== undefined) {
        const { parseListen, serveTui } = await import("@acpus/tui/serve");
        try {
          parseListen(options.serve);
        } catch (error) {
          printError(errorMessage(error), { json: false, quiet: false });
          process.exitCode = EXIT_CLI_ERROR;
          return;
        }
        const client = await ensureSupervisor();
        const endpoint = (client as any).baseUrl as string;
        await serveTui({ runId, endpoint, listen: options.serve });
        return;
      }
      const client = await ensureSupervisor();
      const endpoint = (client as any).baseUrl as string;
      const { runTui } = await import("@acpus/tui");
      await runTui({ runId, endpoint });
    } catch (error) {
      printError(errorMessage(error), { json: false, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

for (const action of ["pause", "resume", "cancel"] as const) {
  runs
    .command(action)
    .argument("<runId>", "run ID")
    .option("--json", "output machine-readable JSON")
    .action(async (runId: string, options: { json?: boolean }) => {
      try {
        const client = await ensureSupervisor();
        const run = action === "pause"
          ? await client.pauseRun(runId)
          : action === "resume"
            ? await client.resumeRun(runId)
            : await client.cancelRun(runId);
        if (options.json) console.log(JSON.stringify(run));
        else console.log(`Run ${runId} ${pastTense(action)} (status: ${run.status})`);
      } catch (error) {
        printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
        process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
      }
    });
}

runs
  .command("retry")
  .argument("<runId>", "run ID")
  .option("--node <key>", "retry a specific node instead of the whole run")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, options: { node?: string; json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      if (options.node) {
        const state = await client.retryNode(runId, options.node);
        if (options.json) console.log(JSON.stringify(state));
        else console.log(`Node ${options.node} retried (state: ${state.state})`);
      } else {
        const run = await client.retryRun(runId);
        if (options.json) console.log(JSON.stringify(run));
        else console.log(`Run ${runId} retried (status: ${run.status})`);
      }
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("signal")
  .argument("<runId>", "run ID")
  .requiredOption("--node <key>", "the Approval Gate node key to decide on")
  .option("--approve", "approve the gate")
  .option("--reject", "reject the gate")
  .option("--json", "output machine-readable JSON")
  .description("submit a human decision to an Approval Gate awaiting a decision")
  .action(async (runId: string, options: { node: string; approve?: boolean; reject?: boolean; json?: boolean }) => {
    if (options.approve === options.reject) {
      printError("exactly one of --approve or --reject is required", { json: Boolean(options.json), quiet: false });
      process.exitCode = EXIT_RUNTIME_ERROR;
      return;
    }
    const approved = Boolean(options.approve);
    try {
      const client = await ensureSupervisor();
      const state = await client.signalApproval(runId, options.node, approved);
      if (options.json) console.log(JSON.stringify(state));
      else console.log(`Node ${options.node} ${approved ? "approved" : "rejected"} (state: ${state.state})`);
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("replay")
  .argument("<runId>", "run ID")
  .option("--json", "output machine-readable JSON")
  .description("deterministically replay a Run and verify its interpretation")
  .action(async (runId: string, options: { json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const result = await client.replay(runId);
      if (options.json) {
        console.log(JSON.stringify(result));
      } else if (result.ok) {
        console.log(`Replay OK: ${runId} reproduced deterministically.`);
      } else {
        console.log(`Replay MISMATCH: ${runId} (${result.mismatches.length} discrepancies)`);
        for (const m of result.mismatches.slice(0, 10)) {
          console.log(`  ${m.nodeKey} [${m.kind}] expected=${m.expected ?? "-"} actual=${m.actual ?? "-"}`);
        }
      }
      if (!result.ok) process.exitCode = EXIT_RUNTIME_ERROR;
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

runs
  .command("fork")
  .argument("<sourceRunId>", "terminal source Run to fork from")
  .argument("<refOrPath>", "Workflow Catalog ref/name or workflow YAML spec path with the repaired Spec")
  .option("--from <nodeKey>", "force the Fork Origin to a specific Node Key (default: first divergence)")
  .option("--input <value>", "inline JSON or path to YAML/JSON input (default: inherit from source Run)")
  .option("--dry-run", "compute the fork plan without creating a new Run")
  .option("--background", "submit and return immediately (no follow)")
  .option("--visualize", "submit and open TUI visualizer")
  .option("--json", "write JSON output")
  .option("--quiet", "only write final output")
  .description("derive a new Run from a terminal Run, inheriting matching Run Checkpoints from the source")
  .action(async (
    sourceRunId: string,
    refOrPath: string,
    options: { from?: string; input?: string; dryRun?: boolean; background?: boolean; visualize?: boolean; json?: boolean; quiet?: boolean }
  ) => {
    if (options.background && options.visualize) {
      printError("--background and --visualize are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }
    if (options.visualize && options.json) {
      printError("--visualize and --json are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }
    try {
      const target = resolveWorkflowTarget(refOrPath);
      const parsedInput = parseInput(options.input);
      const client = await ensureSupervisor();
      const result = await client.forkRun(sourceRunId, target.source, {
        sourcePath: target.sourcePath,
        workflowRef: target.workflowRef,
        input: parsedInput,
        overrideOriginNodeKey: options.from,
        dryRun: options.dryRun
      });

      if (options.dryRun) {
        if (options.json) {
          console.log(JSON.stringify(result));
        } else if (!options.quiet) {
          console.log(`Fork plan for ${sourceRunId}:`);
          console.log(`  Fork Origin: ${result.plan.forkOriginNodeKey} (${result.plan.boundaryReason})`);
          console.log(`  Inherited Nodes: ${result.plan.inheritedNodeKeys.length}`);
          for (const key of result.plan.inheritedNodeKeys) console.log(`    + ${key}`);
        }
        process.exitCode = 0;
        return;
      }

      if (!result.run) {
        printError("Supervisor returned no Run for non-dry-run fork", options);
        process.exitCode = EXIT_RUNTIME_ERROR;
        return;
      }

      if (options.background) {
        if (options.json) {
          console.log(JSON.stringify(result));
        } else if (!options.quiet) {
          console.log(`Run ${result.run.runId} forked from ${sourceRunId}`);
          console.log(`Fork Origin: ${result.plan.forkOriginNodeKey}`);
          console.log(`Inherited: ${result.plan.inheritedNodeKeys.length} node(s)`);
          console.log(`Status: ${result.run.status}`);
        }
        process.exitCode = 0;
        return;
      }

      if (options.visualize) {
        const { runTui } = await import("@acpus/tui");
        await runTui({ runId: result.run.runId, endpoint: (client as any).baseUrl as string });
        process.exitCode = 0;
        return;
      }

      const terminalStatus = await followRun(client, result.run.runId, { json: options.json });
      process.exitCode = exitCodeForRunStatus(terminalStatus);
    } catch (error) {
      const message = errorMessage(error);
      printError(message, options);
      if (isSupervisorConnectionError(error)) {
        process.exitCode = EXIT_SUPERVISOR_ERROR;
      } else if (error instanceof ForkRejectedError) {
        process.exitCode = EXIT_FORK_REJECTED;
      } else {
        process.exitCode = EXIT_RUNTIME_ERROR;
      }
    }
  });

program.addCommand(runs);

program.parse();

function resolveLintTarget(refOrPath: string): string {
  if (looksLikeWorkflowPath(refOrPath)) return resolveWorkflowPath(refOrPath);
  return findWorkflowCatalogEntry(refOrPath).path;
}

function printWorkflowList(entries: WorkflowCatalogEntry[]): void {
  if (entries.length === 0) {
    console.log("No workflows found.");
    return;
  }
  console.log("SCOPE    STATUS    REF                  NAME                 PATH");
  for (const entry of entries) {
    console.log(`${pad(entry.scope, 8)} ${pad(entry.status, 9)} ${pad(entry.ref ?? "-", 20)} ${pad(entry.name ?? "-", 20)} ${displayPath(entry.path)}`);
  }
}

function printWorkflowDetails(entry: WorkflowCatalogEntry): void {
  console.log(`Workflow: ${entry.name ?? "-"}`);
  console.log(`Ref: ${entry.ref ?? "-"}`);
  console.log(`Scope: ${entry.scope}`);
  console.log(`Status: ${entry.status}`);
  console.log(`Path: ${entry.path}`);
  if (entry.description) console.log(`Description: ${entry.description}`);
  if (entry.inputKeys.length > 0) console.log(`Inputs: ${entry.inputKeys.join(", ")}`);
  if (entry.diagnostics.length > 0) {
    console.log();
    console.log("Diagnostics:");
    for (const diagnostic of entry.diagnostics) {
      console.log(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
}

function printCleanResult(result: RunCleanResult): void {
  const verb = result.dryRun ? "Would delete" : "Deleted";
  console.log(`${verb} ${result.deletedCount} terminal run(s), ${formatBytes(result.bytesReclaimed)}.`);
  if (result.skippedCount > 0) {
    console.log(`Skipped ${result.skippedCount} run(s).`);
  }
}

function exitCodeForRunStatus(status: RunStatus): number {
  switch (status) {
    case "completed": return 0;
    case "failed": return EXIT_RUNTIME_ERROR;
    case "cancelled":
    case "paused": return EXIT_USER_CANCEL;
    default: return 0;
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : path;
}

function createWorkspaceIncludeResolver(): (path: string, fromPath?: string) => string {
  return workflowSourcePolicy().createIncludeResolver();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pastTense(action: "pause" | "resume" | "cancel"): string {
  if (action === "pause") return "paused";
  if (action === "resume") return "resumed";
  return "cancelled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
