import type { Writable } from "node:stream";
import { Command } from "commander";
import { CliError } from "../errors.js";
import { writeResult, type OutputFormat, type CliResult } from "../output.js";
import { preflightWorkflow, runPreflight } from "../preflight.js";
import { RuntimeEngine, RuntimeExecutionError, spawnSupervisor, type StoredRun } from "../runtime/index.js";
import { readJsonOption } from "./json.js";

export type RunCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type RunCommandOptions = {
  dryRun?: boolean;
  json?: boolean;
  input?: string;
  inputFile?: string;
  background?: boolean;
  agentStub?: boolean;
};

export function createRunCommand(ctx: RunCommandContext): Command {
  return new Command("run")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Typecheck, compile, admit, and execute a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path")
    .option("--dry-run", "run the pre-run gate without executing the workflow")
    .option("--input <json>", "workflow input JSON")
    .option("--input-file <path>", "read workflow input JSON from a file")
    .option("--background", "admit the run and wake the workspace supervisor")
    .option("--agent-stub", "allow agent nodes without a configured local runner by returning schema-shaped defaults")
    .option("--json", "print a structured JSON result")
    .action(async (workflow: string, options: RunCommandOptions) => {
      const format: OutputFormat = options.json ? "json" : "text";
      try {
        if (options.dryRun) {
          const result = await runPreflight({ workflow, cwd: ctx.cwd });
          ctx.setExitCode(writeResult(result, format, ctx, 0));
          return;
        }

        const preflight = await preflightWorkflow({ workflow, cwd: ctx.cwd });
        const input = await readJsonOption({ cwd: ctx.cwd, input: options.input, inputFile: options.inputFile, defaultValue: {} });
        const engine = RuntimeEngine.open(ctx.cwd);
        const admitted = await engine.admitWorkflow(preflight.ir, input, {
          workflowPath: workflow,
          preflightDir: preflight.artifact.dir,
          metadata: {
            sourceGraphDigest: preflight.artifact.sourceGraphDigest,
            dryRunArtifact: preflight.artifact.dir,
          },
        });
        const supervisor = options.background ? await spawnSupervisor(ctx.cwd) : undefined;
        const finalRun = options.background ? admitted : await engine.execute(admitted.runId, { agentStub: options.agentStub ?? false });
        const result = runResult(finalRun, engine, {
          message: options.background ? backgroundMessage(supervisor?.started ?? false) : statusMessage(finalRun.status),
          workflow: preflight.summary,
          preflightDir: preflight.artifact.dir,
          irDigest: preflight.artifact.irDigest,
          taskBundleCount: preflight.taskBundleCount,
          sourceGraphDigest: preflight.artifact.sourceGraphDigest,
        });
        ctx.setExitCode(writeResult(result, format, ctx, result.ok ? 0 : 1));
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (error instanceof RuntimeExecutionError) {
          throw new CliError(1, {
            ok: false,
            phase: "run",
            message: error.message,
            error: { code: error.code, details: error.details },
          });
        }
        throw error;
      }
    });
}

function runResult(run: StoredRun, engine: RuntimeEngine, extra: Partial<CliResult> = {}): CliResult {
  const ok = run.status !== "failed" && run.status !== "cancelled";
  return {
    ok,
    phase: "run",
    message: extra.message ?? statusMessage(run.status),
    ...extra,
    runId: run.runId,
    status: run.status,
    runDir: run.runDir,
    output: run.output,
    error: run.error,
    nodes: engine.store.listNodeStates(run.runId),
    artifacts: engine.store.listArtifacts(run.runId),
  };
}

function backgroundMessage(started: boolean): string {
  return started ? "Workflow run admitted and supervisor started." : "Workflow run admitted; supervisor already healthy.";
}

function statusMessage(status: string): string {
  switch (status) {
    case "succeeded": return "Workflow run succeeded.";
    case "awaiting_signal": return "Workflow run is awaiting a signal.";
    case "paused": return "Workflow run is paused.";
    case "queued": return "Workflow run is queued.";
    case "running": return "Workflow run is running.";
    case "cancelled": return "Workflow run was cancelled.";
    default: return "Workflow run failed.";
  }
}
