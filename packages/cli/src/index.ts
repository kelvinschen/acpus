#!/usr/bin/env node
import { resolve } from "node:path";
import { compileWorkflow, lintWorkflow } from "@acpus/core";
import { Command } from "commander";
import { createIncludeResolver, parseInput, readTextFile } from "./io.js";
import { printCompile, printError, printLint } from "./output.js";
import { DaemonClient } from "./daemon-client.js";
import type { NodeExecutionState } from "@acpus/runtime";

const EXIT_DSL_STATIC_ERROR = 10;
const EXIT_RUNTIME_ERROR = 20;
const EXIT_USER_CANCEL = 2;
const EXIT_DAEMON_ERROR = 40;

function isDaemonConnectionError(error: unknown): boolean {
  const msg = errorMessage(error);
  return /ECONNREFUSED|fetch failed|connect|daemon/i.test(msg);
}

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
  .option("--daemon <url>", "daemon URL (default http://127.0.0.1:3839)")
  .option("--json", "write JSONL output")
  .option("--quiet", "only write final output")
  .action(async (spec: string, options: { dryRun?: boolean; input?: string; daemon?: string; json?: boolean; quiet?: boolean }) => {
    try {
      if (options.dryRun) {
        // M1 behavior: compile and print schedule
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

      // M2: submit to daemon for execution
      const client = new DaemonClient(options.daemon);
      const sourcePath = resolve(process.cwd(), spec);
      const specSource = readTextFile(sourcePath);
      const parsedInput = parseInput(options.input);

      const runState = await client.startRun(specSource, parsedInput);

      if (options.json) {
        console.log(JSON.stringify(runState));
      } else if (!options.quiet) {
        console.log(`Run ${runState.runId} started: ${runState.workflowName}`);
        console.log(`Status: ${runState.status}`);
      }

      process.exitCode = 0;
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("daemon")
  .option("--port <port>", "port to listen on", "3839")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .action(async (options: { port?: string; host?: string }) => {
    try {
      const { startDaemon } = await import("@acpus/runtime");
      await startDaemon({
        port: parseInt(options.port ?? "3839", 10),
        host: options.host ?? "127.0.0.1"
      });
    } catch (error) {
      printError(errorMessage(error), { json: false, quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("ls")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "write JSON output")
  .action(async (options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
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
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("inspect")
  .argument("<runId>", "run ID to inspect")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "write JSON output")
  .action(async (runId: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
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
        }
      }
    } catch (error) {
      printError(errorMessage(error), { json: options.json, quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("pause")
  .argument("<runId>", "run ID")
  .argument("<nodeKey>", "node key to pause")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, nodeKey: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
      const state = await client.pauseNode(runId, nodeKey);
      if (options.json) console.log(JSON.stringify(state));
      else console.log(`Node ${nodeKey} paused (state: ${state.state})`);
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("resume")
  .argument("<runId>", "run ID")
  .argument("<nodeKey>", "node key to resume")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, nodeKey: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
      const state = await client.resumeNode(runId, nodeKey);
      if (options.json) console.log(JSON.stringify(state));
      else console.log(`Node ${nodeKey} resumed (state: ${state.state})`);
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("cancel")
  .argument("<runId>", "run ID")
  .argument("<nodeKey>", "node key to cancel")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, nodeKey: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
      const state = await client.cancelNode(runId, nodeKey);
      if (options.json) console.log(JSON.stringify(state));
      else console.log(`Node ${nodeKey} cancelled (state: ${state.state})`);
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("retry")
  .argument("<runId>", "run ID")
  .argument("<nodeKey>", "node key to retry")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "output machine-readable JSON")
  .action(async (runId: string, nodeKey: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
      const state = await client.retryNode(runId, nodeKey);
      if (options.json) console.log(JSON.stringify(state));
      else console.log(`Node ${nodeKey} retried (state: ${state.state})`);
    } catch (error) {
      printError(errorMessage(error), { json: Boolean(options.json), quiet: false });
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program
  .command("replay")
  .argument("<runId>", "run ID")
  .option("--daemon <url>", "daemon URL")
  .option("--json", "output machine-readable JSON")
  .description("deterministically replay a Run and verify its interpretation")
  .action(async (runId: string, options: { daemon?: string; json?: boolean }) => {
    try {
      const client = new DaemonClient(options.daemon);
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
      process.exitCode = isDaemonConnectionError(error) ? EXIT_DAEMON_ERROR : EXIT_RUNTIME_ERROR;
    }
  });

program.parse();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
