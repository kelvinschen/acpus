import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { issue, resultFromIssues, type OrchestratorIssue } from "../errors.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex } from "../run-index/read-write.js";
import { mergeResumePolicy, parseResumePolicyOptions, validateResumePolicy } from "../runtime/resume-policy.js";
import { syncRun } from "../runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema/workflow-spec.js";
import { printIssues, printJson } from "./common.js";

export function registerResume(program: Command): void {
  program.command("resume")
    .argument("<run>", "logical run id or run directory")
    .option("--allow-partial-fanout <stage...>", "allow partial results for read-only fanout stage(s) on resume")
    .option("--max-fanout-items <stage=count...>", "tighten max fanout items for stage(s), bounded by the compiled snapshot")
    .option("--skip-fanout-item <stage=index...>", "skip zero-based fanout item index(es) on resume")
    .option("--wait", "advance until terminal")
    .option("--json", "print JSON")
    .action(async (runArg: string, options: { allowPartialFanout?: string[]; maxFanoutItems?: string[]; skipFanoutItem?: string[]; wait?: boolean; json?: boolean }) => {
      const locator = await resolveRunLocator(runArg);
      const spec = await readRunSpec(locator.cwd, locator.runId);
      const parsedPolicy = parseResumePolicyOptions(options);
      const policyIssues = [...parsedPolicy.issues, ...validateResumePolicy(spec, parsedPolicy.policy)];
      if (policyIssues.some((entry) => entry.severity !== "warning")) {
        printResumeIssues(options.json, policyIssues);
        process.exitCode = 2;
        return;
      }

      const index = await readRunIndex(locator.cwd, locator.runId);
      const reset = resetRecoverableStages({
        ...index,
        resumePolicy: mergeResumePolicy(index.resumePolicy, parsedPolicy.policy)
      });
      await writeRunIndex(locator.cwd, reset);
      let finalIndex;
      try {
        finalIndex = options.wait ? await waitForResume(locator.cwd, locator.runId) : await syncRun(locator.cwd, locator.runId);
      } catch (error) {
        await markKnownRunFatal(locator.cwd, locator.runId, error);
        throw error;
      }
      const output = {
        ok: true,
        runId: locator.runId,
        status: finalIndex.status,
        message: options.wait ? "Run resume reached a terminal state or current scheduler quiescence." : "Run resume advanced one scheduler tick."
      };
      if (options.json) printJson(output);
      else process.stdout.write(`${output.message}\n`);
    });
}

async function readRunSpec(cwd: string, runId: string): Promise<WorkflowSpec> {
  return WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(runDir(runId, cwd), "workflow.spec.json"), "utf8")));
}

function resetRecoverableStages(index: Awaited<ReturnType<typeof readRunIndex>>) {
  const stages = Object.fromEntries(Object.entries(index.stages).map(([id, stage]) => [
    id,
    stage.status === "failed" || stage.status === "blocked"
      ? {
          ...stage,
          status: stage.fanout ? "running" as const : "pending" as const,
          blockedReason: undefined,
          completedAt: undefined
        }
      : stage
  ]));
  return { ...index, status: "running" as const, stages, blockedReason: undefined, finalVerdict: undefined };
}

function printResumeIssues(json: boolean | undefined, issues: OrchestratorIssue[]): void {
  const result = resultFromIssues("resume", issues.map(issue));
  if (json) printJson(result);
  else printIssues(result);
}

async function waitForResume(cwd: string, runId: string) {
  while (true) {
    const index = await syncRun(cwd, runId);
    if (index.status !== "pending" && index.status !== "running") return index;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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
