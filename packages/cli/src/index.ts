#!/usr/bin/env node
import { resolve } from "node:path";
import { compileWorkflow, lintWorkflow } from "@acpus/core";
import { Command } from "commander";
import { createIncludeResolver, parseInput, readTextFile } from "./io.js";
import { printCompile, printError, printLint } from "./output.js";
import { RunSupervisorClient } from "./supervisor-client.js";
import { ensureSupervisor, EXIT_SUPERVISOR_ERROR, isSupervisorConnectionError } from "./supervisor.js";
import { followRun } from "./follow.js";
import type { RunState, NodeExecutionState, SupervisorMetadata } from "@acpus/runtime";

const EXIT_DSL_STATIC_ERROR = 10;
const EXIT_RUNTIME_ERROR = 20;
const EXIT_USER_CANCEL = 2;
const EXIT_CLI_ERROR = 1;
// EXIT_SUPERVISOR_ERROR = 40 (imported from supervisor.ts)

const program = new Command();

program
  .name("acpus")
  .description("Local durable ACP workflow runner")
  .version("0.1.0");

program
  .command("lint")
  .argument("<spec>", "workflow YAML spec")
  .option("--strict", "treat warnings as errors")
  .option("--json", "write JSONL output")
  .option("--quiet", "only write final output")
  .action((spec: string, options: { strict?: boolean; json?: boolean; quiet?: boolean }) => {
    try {
      const sourcePath = resolve(process.cwd(), spec);
      const result = lintWorkflow(readTextFile(sourcePath), {
        sourcePath,
        strict: options.strict,
        includeResolver: createIncludeResolver()
      });
      printLint(result, options);
      process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("run")
  .argument("<spec>", "workflow YAML spec")
  .option("--dry-run", "compile to IR and print schedule without execution")
  .option("--input <value>", "inline JSON or path to YAML/JSON input object")
  .option("--background", "submit and return immediately (no follow)")
  .option("--watch", "submit and open TUI")
  .option("--json", "write JSONL observations (follow mode) or JSON (background)")
  .option("--quiet", "only write final output")
  .action(async (spec: string, options: { dryRun?: boolean; input?: string; background?: boolean; watch?: boolean; json?: boolean; quiet?: boolean }) => {
    // Validate invalid combinations before any supervisor contact
    if (options.background && options.watch) {
      printError("--background and --watch are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }
    if (options.watch && options.json) {
      printError("--watch and --json are mutually exclusive", options);
      process.exitCode = EXIT_CLI_ERROR;
      return;
    }

    try {
      if (options.dryRun) {
        // Dry-run: compile and print schedule, no supervisor needed
        const sourcePath = resolve(process.cwd(), spec);
        const parsedInput = parseInput(options.input);
        const result = compileWorkflow(readTextFile(sourcePath), {
          sourcePath,
          includeResolver: createIncludeResolver()
        });
        const output = parsedInput === undefined || !result.ir ? result : { ...result, ir: { ...result.ir, runtimeInput: parsedInput } };
        printCompile(output, options);
        process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
        return;
      }

      // Ensure supervisor is running
      const client = await ensureSupervisor();
      const sourcePath = resolve(process.cwd(), spec);
      const specSource = readTextFile(sourcePath);
      const parsedInput = parseInput(options.input);

      const runState = await client.startRun(specSource, parsedInput, sourcePath);

      if (options.background) {
        // Background: print ID/status and exit
        if (options.json) {
          console.log(JSON.stringify(runState));
        } else if (!options.quiet) {
          console.log(`Run ${runState.runId} started: ${runState.workflowName}`);
          console.log(`Status: ${runState.status}`);
        }
        process.exitCode = 0;
        return;
      }

      if (options.watch) {
        // Watch: submit and open TUI
        const { runTui } = await import("@acpus/tui");
        await runTui({ runId: runState.runId, endpoint: (client as any).baseUrl as string });
        process.exitCode = 0;
        return;
      }

      // Default: foreground follow
      const terminalStatus = await followRun(client, runState.runId, { json: options.json });

      // Exit code mapping
      switch (terminalStatus) {
        case "completed": process.exitCode = 0; break;
        case "failed": process.exitCode = EXIT_RUNTIME_ERROR; break;
        case "cancelled":
        case "paused": process.exitCode = EXIT_USER_CANCEL; break;
        default: process.exitCode = EXIT_RUNTIME_ERROR; break;
      }
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("ls")
  .option("--json", "write JSON output")
  .action(async (options: { json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const runs = await client.listRuns();

      if (options.json) {
        console.log(JSON.stringify(runs));
      } else {
        if (runs.length === 0) {
          console.log("No runs found.");
        } else {
          for (const run of runs) {
            console.log(`${run.runId}  ${run.workflowName}  ${run.status}  ${run.createdAt}`);
          }
        }
      }
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("inspect")
  .argument("<runId>", "run ID to inspect")
  .option("--json", "write JSON output")
  .action(async (runId: string, options: { json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      const run = await client.getRun(runId);

      if (options.json) {
        console.log(JSON.stringify(run));
      } else {
        console.log(`Run: ${run.runId}`);
        console.log(`Workflow: ${run.workflowName}`);
        console.log(`Status: ${run.status}`);
        console.log(`Created: ${run.createdAt}`);
        console.log(`Updated: ${run.updatedAt}`);
        console.log();
        console.log("Nodes:");
        for (const node of run.nodes ?? []) {
          console.log(`  ${node.nodeKey}  [${node.kind}]  ${node.state}  attempt=${node.attempt}`);
          if (node.error) {
            console.log(`    Error: ${node.error}`);
          }
          if (node.artifactRefs?.length) {
            console.log(`    Artifacts: ${node.artifactRefs.join(", ")}`);
          }
        }
      }
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

// ─── Control commands ──────────────────────────────────────────────
// Unified: Run-level by default, Node-level with --node <key>

program
  .command("pause")
  .argument("<runId>", "run ID")
  .option("--node <key>", "pause a specific node instead of the whole run")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, options: { node?: string; json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      if (options.node) {
        const state = await client.pauseNode(runId, options.node);
        if (options.json) console.log(JSON.stringify(state));
        else console.log(`Node ${options.node} paused (state: ${state.state})`);
      } else {
        const run = await client.pauseRun(runId);
        if (options.json) console.log(JSON.stringify(run));
        else console.log(`Run ${runId} paused (status: ${run.status})`);
      }
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("resume")
  .argument("<runId>", "run ID")
  .option("--node <key>", "resume a specific node instead of the whole run")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, options: { node?: string; json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      if (options.node) {
        const state = await client.resumeNode(runId, options.node);
        if (options.json) console.log(JSON.stringify(state));
        else console.log(`Node ${options.node} resumed (state: ${state.state})`);
      } else {
        const run = await client.resumeRun(runId);
        if (options.json) console.log(JSON.stringify(run));
        else console.log(`Run ${runId} resumed (status: ${run.status})`);
      }
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("cancel")
  .argument("<runId>", "run ID")
  .option("--node <key>", "cancel a specific node instead of the whole run")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, options: { node?: string; json?: boolean }) => {
    try {
      const client = await ensureSupervisor();
      if (options.node) {
        const state = await client.cancelNode(runId, options.node);
        if (options.json) console.log(JSON.stringify(state));
        else console.log(`Node ${options.node} cancelled (state: ${state.state})`);
      } else {
        const run = await client.cancelRun(runId);
        if (options.json) console.log(JSON.stringify(run));
        else console.log(`Run ${runId} cancelled (status: ${run.status})`);
      }
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
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

program
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

program
  .command("watch")
  .argument("[runId]", "run ID to watch (omit to pick from a list)")
  .description("open a terminal UI to observe and control a running workflow")
  .action(async (runId: string | undefined) => {
    try {
      const client = await ensureSupervisor();
      const endpoint = (client as any).baseUrl as string;
      const { runTui } = await import("@acpus/tui");
      await runTui({ runId, endpoint });
    } catch (error) {
      printError(errorMessage(error), { json: false, quiet: false });
      process.exitCode = isSupervisorConnectionError(error) ? EXIT_SUPERVISOR_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program.parse();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
