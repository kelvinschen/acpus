import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { issue, resultFromIssues, type OrchestratorIssue } from "../errors.js";
import type { ExecutionPlan } from "../compiler/execution-plan.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex } from "../run-index/read-write.js";
import { mergeResumePolicy, parseResumePolicyOptions, validateResumePolicy } from "../runtime/resume-policy.js";
import { runWorkflowWorker, spawnBackgroundWorker, workerIsActive } from "../runtime/worker.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema/workflow-spec.js";
import { printIssues, printJson } from "./common.js";

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

export function registerResume(program: Command): void {
  program.command("resume")
    .argument("<run>", "logical run id or run directory")
    .option("--allow-partial-fanout <stage...>", "allow partial results for read-only fanout stage(s) on resume")
    .option("--max-fanout-items <stage=count...>", "tighten max fanout items for stage(s), bounded by the compiled snapshot")
    .option("--skip-fanout-item <stage=index...>", "skip zero-based fanout item index(es) on resume")
    .option("--force", "bypass active-worker check to restart a stale worker")
    .option("--wait", "advance until terminal")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { allowPartialFanout?: string[]; maxFanoutItems?: string[]; skipFanoutItem?: string[]; force?: boolean; wait?: boolean; json?: boolean }) => {
      const locator = await resolveRunLocator(runArg);
      const spec = await readRunSpec(locator.cwd, locator.runId);
      const plan = await readRunPlan(locator.cwd, locator.runId);
      const parsedPolicy = parseResumePolicyOptions(options);
      const policyIssues = [...parsedPolicy.issues, ...validateResumePolicy(spec, parsedPolicy.policy, plan)];
      if (policyIssues.some((entry) => entry.severity !== "warning")) {
        printResumeIssues(options.json, policyIssues);
        process.exitCode = 2;
        return;
      }

      const index = await readRunIndex(locator.cwd, locator.runId);

      // Status validation
      const allowedStatuses = options.force
        ? new Set(["blocked", "failed", "running", "pending"])
        : new Set(["blocked", "failed"]);
      if (TERMINAL_STATUSES.has(index.status) || !allowedStatuses.has(index.status)) {
        const hint = options.force && (index.status === "running" || index.status === "pending")
          ? "Use monitor to observe the active run."
          : index.status === "running" || index.status === "pending"
            ? "Use monitor to observe the active run, recover if its worker is stale, or use --force to bypass."
            : "Start a new run for completed workflows.";
        printResumeIssues(options.json, [issue({
          code: "RESUME_POLICY_INVALID",
          severity: "error",
          path: "/",
          message: `Run ${locator.runId} is ${index.status}; resume is only for blocked or failed runs${options.force ? " (or running with --force)" : ""}.`,
          suggestions: [hint]
        })]);
        process.exitCode = 2;
        return;
      }

      // Active-worker guard (--force bypasses for stale workers, rejects for truly active workers)
      if (workerIsActive(index.worker) && !options.force) {
        printResumeIssues(options.json, [issue({
          code: "RESUME_POLICY_INVALID",
          severity: "error",
          path: "/",
          message: `Run ${locator.runId} already has an active worker pid=${index.worker?.pid}; resume cannot take ownership.`,
          suggestions: ["Use monitor to observe the active run, recover after the worker becomes stale, or use --force to bypass."]
        })]);
        process.exitCode = 2;
        return;
      }
      if (workerIsActive(index.worker) && options.force) {
        printResumeIssues(options.json, [issue({
          code: "RESUME_POLICY_INVALID",
          severity: "error",
          path: "/",
          message: `Run ${locator.runId} has an active worker pid=${index.worker?.pid}; --force cannot take ownership of an active worker.`,
          suggestions: ["Use monitor to observe the active run, or wait for the worker to become stale."]
        })]);
        process.exitCode = 2;
        return;
      }

      const reset = resetRecoverableStages({
        ...index,
        resumePolicy: mergeResumePolicy(index.resumePolicy, parsedPolicy.policy)
      }, spec);
      await writeRunIndex(locator.cwd, reset);
      let finalIndex;
      try {
        finalIndex = options.wait ? await runWorkflowWorker(locator.cwd, locator.runId, { force: options.force }) : await readRunIndex(locator.cwd, locator.runId);
        const worker = options.wait ? finalIndex.worker : await spawnBackgroundWorker(locator.cwd, locator.runId);
        if (!options.wait) finalIndex = { ...await readRunIndex(locator.cwd, locator.runId), worker };
      } catch (error) {
        await markKnownRunFatal(locator.cwd, locator.runId, error);
        throw error;
      }
      const output = {
        ok: true,
        runId: locator.runId,
        status: finalIndex.status,
        worker: finalIndex.worker,
        message: options.wait ? "Run resume reached a terminal state." : "Run resume started a background worker."
      };
      if (options.json) printJson(output);
      else {
        process.stdout.write(`${output.message}\n`);
        if (!options.wait) {
          process.stdout.write(`runId=${output.runId}\n`);
          process.stdout.write(`runDir=${runDir(locator.runId, locator.cwd)}\n`);
          if (output.worker) process.stdout.write(`worker=${output.worker.pid ?? "unknown"}\n`);
        }
      }
    });
}

async function readRunSpec(cwd: string, runId: string): Promise<WorkflowSpec> {
  return WorkflowSpecSchema.parse(YAML.parse(await fs.readFile(path.join(runDir(runId, cwd), "workflow.spec.yaml"), "utf8")));
}

async function readRunPlan(cwd: string, runId: string): Promise<ExecutionPlan> {
  return JSON.parse(await fs.readFile(path.join(runDir(runId, cwd), "execution-plan.json"), "utf8")) as ExecutionPlan;
}

function resetRecoverableStages(index: Awaited<ReturnType<typeof readRunIndex>>, spec: WorkflowSpec) {
  const kindByStage = new Map(spec.stages.map((stage) => [stage.id, stage.kind]));
  const shouldRecomputeGate = index.gateVerdict === "blocked" || index.gateVerdict === "failed" || index.gateVerdict === "unknown";
  let gateVerdict = index.gateVerdict;
  let resetGate = false;
  const stages = Object.fromEntries(Object.entries(index.stages).map(([id, stage]) => {
    const stageKind = kindByStage.get(id);
    const shouldResetBlockedStage = stage.status === "failed" || stage.status === "blocked";
    const shouldResetBlockedVerdictGate = stageKind === "gate" && shouldRecomputeGate;
    if (!shouldResetBlockedStage && !shouldResetBlockedVerdictGate) return [id, stage];
    if (stageKind === "gate") {
      gateVerdict = undefined;
      resetGate = true;
    }
    return [id, {
      ...stage,
      status: stage.fanout ? "running" as const : "pending" as const,
      blockedReason: undefined,
      completedAt: undefined,
      outputPath: stageKind === "gate" ? undefined : stage.outputPath
    }];
  }));
  return {
    ...index,
    status: "running" as const,
    stages,
    blockedReason: undefined,
    gateVerdict: resetGate ? gateVerdict : index.gateVerdict
  };
}

function printResumeIssues(json: boolean | undefined, issues: OrchestratorIssue[]): void {
  const result = resultFromIssues("resume", issues.map(issue));
  if (json) printJson(result);
  else printIssues(result);
}

async function markKnownRunFatal(cwd: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const index = await readRunIndex(cwd, runId);
    await writeRunIndex(cwd, {
      ...index,
      status: "failed",
      blockedReason: `RUNTIME_COMMAND_ERROR: ${message}`
    });
    await appendEvent(cwd, runId, {
      type: "runtime_fatal",
      code: "RUNTIME_COMMAND_ERROR",
      status: "failed",
      errorMessage: message,
      errorMetadata: error instanceof Error && "metadata" in error ? (error as { metadata?: unknown }).metadata : undefined
    });
  } catch {
    // Preserve the original CLI failure; best-effort terminal status only.
  }
}
