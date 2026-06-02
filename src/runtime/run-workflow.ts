import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compileExecutionPlan } from "../compiler/compile.js";
import { estimateAgentCalls } from "../projections/run-view.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { syncRun } from "./sync.js";

export type PreparedRun = {
  logicalRunId: string;
  dir: string;
  index: RunIndex;
};

export async function prepareRun(spec: WorkflowSpec, options: {
  cwd: string;
  input: Record<string, unknown>;
  sourcePath?: string;
}): Promise<PreparedRun> {
  const logicalRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = runDir(logicalRunId, options.cwd);
  const plan = compileExecutionPlan(spec);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
  await fs.mkdir(path.join(dir, "attempts"), { recursive: true });
  await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(dir, "acpx-state", "sessions"), { recursive: true });

  await fs.writeFile(path.join(dir, "workflow.spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "execution-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "input.json"), `${JSON.stringify(options.input, null, 2)}\n`, "utf8");

  const now = new Date().toISOString();
  const index: RunIndex = {
    schemaVersion: "acpus.run/v2",
    logicalRunId,
    workflowName: spec.name,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: options.sourcePath ? { kind: "spec", path: options.sourcePath } : undefined,
    stages: Object.fromEntries(spec.stages.map((stage) => [stage.id, {
      stageId: stage.id,
      status: "pending" as const,
      attempts: []
    }])),
    attempts: {},
    agentUsage: {
      planned: estimateAgentCalls(spec),
      actual: 0,
      repairCalls: 0,
      recoveryCalls: 0
    }
  };
  await writeRunIndex(options.cwd, index);
  await appendEvent(options.cwd, logicalRunId, { type: "run_prepared", workflowName: spec.name, executionPlanVersion: plan.version });
  return { logicalRunId, dir, index };
}

export async function startPreparedRun(cwd: string, prepared: PreparedRun, options: { drainFanoutPool?: boolean } = {}): Promise<RunIndex> {
  await appendEvent(cwd, prepared.logicalRunId, { type: "run_started" });
  return syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: options.drainFanoutPool });
}
