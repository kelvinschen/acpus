import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunReportView } from "../../src/projections/run-report.js";
import { compileExecutionPlan } from "../../src/compiler/compile.js";
import { runDir } from "../../src/run-index/paths.js";
import { writeRunIndex, type RunIndex } from "../../src/run-index/read-write.js";
import { SCHEMA_VERSION, WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

export type ReportFixtureKind = "completed-success" | "blocked-before-gate" | "fanout-partial" | "long-content";

export type ReportFixture = {
  cwd: string;
  runId: string;
  dir: string;
  spec: WorkflowSpec;
  index: RunIndex;
};

export async function createReportFixture(kind: ReportFixtureKind): Promise<ReportFixture> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `acpx-report-${kind}-`));
  const runId = kind;
  const dir = runDir(runId, cwd);
  await fs.mkdir(dir, { recursive: true });
  if (kind === "fanout-partial") return writeFanoutPartialFixture(cwd, runId, dir);
  return writeLinearFixture(cwd, runId, dir, kind);
}

export async function writeReportWebBundle(root: string): Promise<void> {
  const webRoot = path.join(root, "dist", "report-web");
  await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(webRoot, "index.html"), [
    "<!doctype html>",
    "<html><head>",
    "<link rel=\"stylesheet\" href=\"./assets/index.css\">",
    "</head><body><div id=\"root\"></div>",
    "<script type=\"module\" src=\"./assets/index.js\"></script>",
    "</body></html>"
  ].join(""), "utf8");
  await fs.writeFile(path.join(webRoot, "assets", "index.css"), "body { color: #111; }\n", "utf8");
  await fs.writeFile(path.join(webRoot, "assets", "index.js"), "window.__reportLoaded = true;\n", "utf8");
}

export function minimalReportView(runId = "fixture-run"): RunReportView {
  return {
    version: "acpx-workflow-orchestrator.report/v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "snapshot",
    summary: {
      logicalRunId: runId,
      workflowName: "fixture",
      status: "completed",
      gateVerdict: "pass",
      summary: "Fixture summary",
      checks: [],
      finalWarnings: [],
      risks: [],
      warnings: [],
      errors: [],
      roles: [],
      stages: [],
      attempts: [],
      agentUsage: { planned: 1, actual: 1, repairCalls: 0 },
      artifacts: [],
      commands: {}
    },
    run: {
      logicalRunId: runId,
      workflowName: "fixture",
      status: "completed",
      gateVerdict: "pass",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      runDir: "/tmp/fixture"
    },
    metrics: {
      stagesTotal: 1,
      stagesCompleted: 1,
      stagesBlocked: 0,
      stagesFailed: 0,
      stagesRunning: 0,
      stagesPending: 0,
      attemptsTotal: 1,
      attemptsRunning: 0,
      attemptsCompleted: 1,
      attemptsBlocked: 0,
      attemptsFailed: 0,
      agentCallsPlanned: 1,
      agentCallsActual: 1,
      repairCalls: 0,
      recoveryCalls: 0
    },
    graph: {
      nodes: [{
        id: "gate",
        label: "gate",
        kind: "gate",
        status: "completed",
        detailRef: "gate",
        badges: ["gate"],
        metrics: {}
      }],
      edges: []
    },
    stages: [{
      id: "gate",
      kind: "gate",
      dependsOn: [],
      status: "completed",
      summary: "Fixture summary",
      relatedAttemptIds: ["gate:attempt-1"],
      relatedEventIds: [],
      output: { text: "{\"status\":\"completed\"}", truncated: false, path: "/tmp/fixture/output.json" }
    }],
    attempts: [{
      id: "gate:attempt-1",
      stageId: "gate",
      kind: "attempt",
      status: "completed",
      path: "attempts/gate/attempt-1"
    }],
    events: [],
    artifacts: [],
    diagnostics: []
  };
}

async function writeLinearFixture(cwd: string, runId: string, dir: string, kind: Exclude<ReportFixtureKind, "fanout-partial">): Promise<ReportFixture> {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: kind,
    description: "Linear report fixture",
    root: "plan",
    inputs: { task: { type: "string" } },
    roles: {
      planner: { category: "planning", agent: "aiden", mode: "readOnly" },
      worker: { category: "implementation", agent: "trae", mode: "edit" }
    },
    limits: { stageTimeoutMinutes: 60 },
    stages: [
      { id: "plan", kind: "agentTask", role: "planner", prompt: "Plan" },
      { id: "implement", kind: "agentTask", dependsOn: ["plan"], role: "worker", prompt: "Implement" },
      { id: "gate", kind: "gate", dependsOn: ["implement"] }
    ]
  });
  const long = "Long report content. ".repeat(700);
  const outputs: Record<string, Record<string, unknown>> = {
    plan: { status: "completed", summary: "Plan created", artifacts: [], nextFocus: "implement" },
    implement: kind === "blocked-before-gate"
      ? {
          status: "blocked",
          summary: "Implementation blocked",
          blockedReason: "Required file is outside the allowed path scope.",
          parseDiagnostics: {
            errorCode: "OUTPUT_SCHEMA_FAILED",
            summary: "Last balanced JSON object did not satisfy the implementation contract.",
            candidateCount: 1,
            bestCandidateId: "candidate-1",
            recoverability: "repairable",
            candidates: [{ id: "candidate-1", schemaErrors: [{ path: "/status", message: "Invalid option: expected one of \"completed\"|\"blocked\"" }] }]
          },
          artifacts: [],
          nextFocus: "diagnose"
        }
      : {
          status: "completed",
          summary: kind === "long-content" ? long : "Implementation complete",
          artifacts: [{ kind: "file", path: "src/app.ts", label: "Changed app file" }],
          nextFocus: "gate",
          metadata: { outputParse: { mode: "lastBalancedJson", repaired: false, candidateCount: 1, warnings: [] } },
          changedFiles: ["src/app.ts"],
          checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
          data: kind === "long-content" ? { body: long } : undefined
        },
    gate: {
      status: "completed",
      summary: "Workflow completed",
      artifacts: [],
      nextFocus: "",
      verdict: kind === "long-content" ? "pass_with_warnings" : "pass",
      deliverables: ["Implementation complete"],
      changedFiles: ["src/app.ts"],
      checks: [{ command: "npm test", status: "pass", summary: "Tests passed" }],
      warnings: kind === "long-content" ? ["Large output was truncated in report previews."] : [],
      risks: [],
      nextActions: []
    }
  };
  if (kind === "blocked-before-gate") delete outputs.gate;
  const attempts = kind === "blocked-before-gate"
    ? ["plan", "implement"]
    : ["plan", "implement", "gate"];
  await writeRunFiles({ dir, spec, outputs, attempts, promptText: kind === "long-content" ? long : undefined });
  const index = await writeIndex({
    cwd,
    logicalRunId: runId,
    workflowName: spec.name,
    status: kind === "blocked-before-gate" ? "blocked" : "completed",
    gateVerdict: kind === "blocked-before-gate" ? undefined : (kind === "long-content" ? "pass_with_warnings" : "pass"),
    blockedReason: kind === "blocked-before-gate" ? "Required file is outside the allowed path scope." : undefined,
    stageIds: spec.stages.map((stage) => stage.id),
    completedStageIds: Object.keys(outputs).filter((stage) => outputs[stage]?.status === "completed"),
    blockedStageIds: Object.keys(outputs).filter((stage) => outputs[stage]?.status === "blocked"),
    attempts,
    agentUsage: { planned: 3, actual: attempts.length, repairCalls: kind === "blocked-before-gate" ? 1 : 0, recoveryCalls: 0 }
  });
  return { cwd, runId, dir, spec, index };
}

async function writeFanoutPartialFixture(cwd: string, runId: string, dir: string): Promise<ReportFixture> {
  const spec = WorkflowSpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: "fanout-partial",
    description: "Fanout report fixture",
    root: "discover_files",
    inputs: { task: { type: "string" }, files: { type: "array<json>", default: [] } },
    roles: {
      reviewer: { category: "review", agent: "aiden", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 60 },
    stages: [
      { id: "discover_files", kind: "discover", method: "glob", args: { pattern: "src/**/*.ts" }, output: "files" },
      { id: "review_files", kind: "fanout", dependsOn: ["discover_files"], role: "reviewer", items: { source: "outputs.discover_files.files" }, limits: { maxConcurrency: 2, maxFanoutItems: 5 }, prompt: "Review", fanoutPolicy: { allowPartial: true, minCompletedRatio: 0.5, maxBlockedItems: 2 } },
      { id: "reconcile", kind: "reduce", mode: "agent", role: "reviewer", from: "review_files", dependsOn: ["review_files"], prompt: "Reconcile" },
      { id: "gate", kind: "gate", dependsOn: ["reconcile"] }
    ]
  });
  const outputs = {
    discover_files: { status: "completed", summary: "Discovered files", artifacts: [], nextFocus: "review", files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] },
    review_files: { status: "completed", summary: "Fanout completed", artifacts: [], nextFocus: "reconcile", items: [validation("a"), validation("b"), { ...validation("c"), status: "blocked", blockedReason: "item blocked" }], blockedItems: [{ ...validation("c"), status: "blocked", blockedReason: "item blocked" }] },
    reconcile: validation("Reconciled"),
    gate: { status: "completed", summary: "Done", artifacts: [], nextFocus: "", verdict: "pass_with_warnings", deliverables: [], changedFiles: [], checks: [], warnings: ["One item blocked."], risks: [], nextActions: [] }
  };
  await writeRunFiles({ dir, spec, outputs, attempts: ["review_files:item-a", "review_files:item-b", "review_files:item-c", "reconcile", "gate"] });
  await fs.mkdir(path.join(dir, "outputs", "review_files"), { recursive: true });
  await fs.writeFile(path.join(dir, "outputs", "review_files", "item-a.json"), `${JSON.stringify(validation("a"), null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "outputs", "review_files", "item-b.json"), `${JSON.stringify(validation("b"), null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "outputs", "review_files", "item-c.json"), `${JSON.stringify({ ...validation("c"), status: "blocked", blockedReason: "item blocked" }, null, 2)}\n`, "utf8");
  const index = await writeIndex({
    cwd,
    logicalRunId: runId,
    workflowName: spec.name,
    status: "completed",
    gateVerdict: "pass_with_warnings",
    stageIds: spec.stages.map((stage) => stage.id),
    completedStageIds: spec.stages.map((stage) => stage.id),
    blockedStageIds: [],
    attempts: ["review_files:item-a", "review_files:item-b", "review_files:item-c", "reconcile", "gate"],
    fanout: {
      stageId: "review_files",
      totalItems: 3,
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true
    },
    agentUsage: { planned: 5, actual: 5, repairCalls: 0, recoveryCalls: 0 }
  });
  return { cwd, runId, dir, spec, index };
}

async function writeRunFiles(options: {
  dir: string;
  spec: WorkflowSpec;
  outputs: Record<string, Record<string, unknown>>;
  attempts: string[];
  promptText?: string;
}): Promise<void> {
  await fs.writeFile(path.join(options.dir, "workflow.spec.json"), `${JSON.stringify(options.spec, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.dir, "execution-plan.json"), `${JSON.stringify(compileExecutionPlan(options.spec), null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.dir, "input.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(options.dir, "outputs"), { recursive: true });
  await fs.mkdir(path.join(options.dir, "prompts"), { recursive: true });
  for (const [stageId, output] of Object.entries(options.outputs)) {
    await fs.writeFile(path.join(options.dir, "outputs", `${stageId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(options.dir, "prompts", `${stageId}.md`), options.promptText ?? `Prompt for ${stageId}`, "utf8");
  }
  for (const attempt of options.attempts) {
    const [stageId, itemId] = attempt.split(":item-");
    const attemptDir = itemId ? path.join(options.dir, "attempts", stageId, `item-item-${itemId}`, "attempt-1") : path.join(options.dir, "attempts", stageId, "attempt-1");
    await fs.mkdir(attemptDir, { recursive: true });
    await fs.writeFile(path.join(attemptDir, "prompt.md"), options.promptText ?? `Prompt for ${stageId}`, "utf8");
    await fs.writeFile(path.join(attemptDir, "raw.txt"), "raw output", "utf8");
    await fs.writeFile(path.join(attemptDir, "parse.json"), "{\"errorCode\":\"OK\"}\n", "utf8");
    await fs.writeFile(path.join(attemptDir, "output.json"), `${JSON.stringify(options.outputs[stageId] ?? validation(stageId), null, 2)}\n`, "utf8");
  }
  await fs.writeFile(path.join(options.dir, "events.ndjson"), `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", type: "fixture" })}\n`, "utf8");
}

async function writeIndex(options: {
  cwd: string;
  logicalRunId: string;
  workflowName: string;
  status: RunIndex["status"];
  gateVerdict?: RunIndex["gateVerdict"];
  blockedReason?: string;
  stageIds: string[];
  completedStageIds: string[];
  blockedStageIds: string[];
  attempts: string[];
  fanout?: { stageId: string; totalItems: number; completedItems: number; blockedItems: number; allowPartial: boolean };
  agentUsage: RunIndex["agentUsage"];
}): Promise<RunIndex> {
  const dir = runDir(options.logicalRunId, options.cwd);
  const index: RunIndex = {
    schemaVersion: "acpx-workflow-orchestrator.run/v2",
    logicalRunId: options.logicalRunId,
    workflowName: options.workflowName,
    status: options.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    stages: Object.fromEntries(options.stageIds.map((stageId) => [stageId, {
      stageId,
      status: options.completedStageIds.includes(stageId) ? "completed" : options.blockedStageIds.includes(stageId) ? "blocked" : "skipped",
      attempts: options.attempts.filter((attempt) => attempt.startsWith(stageId)).map((attempt) => attemptIdFromFixture(attempt)),
      outputPath: options.completedStageIds.includes(stageId) || options.blockedStageIds.includes(stageId) ? `outputs/${stageId}.json` : undefined,
      blockedReason: options.blockedStageIds.includes(stageId) ? options.blockedReason : undefined,
      fanout: options.fanout?.stageId === stageId ? {
        totalItems: options.fanout.totalItems,
        completedItems: options.fanout.completedItems,
        blockedItems: options.fanout.blockedItems,
        allowPartial: options.fanout.allowPartial,
        items: [
          { id: "item-a", index: 0, status: "completed", outputPath: "outputs/review_files/item-a.json" },
          { id: "item-b", index: 1, status: "completed", outputPath: "outputs/review_files/item-b.json" },
          { id: "item-c", index: 2, status: "blocked", outputPath: "outputs/review_files/item-c.json", blockedReason: "item blocked" }
        ]
      } : undefined
    }])),
    attempts: Object.fromEntries(options.attempts.map((attempt) => {
      const [stageId, itemSuffix] = attempt.split(":item-");
      const id = attemptIdFromFixture(attempt);
      const itemId = itemSuffix ? `item-${itemSuffix}` : undefined;
      return [id, {
        id,
        stageId,
        itemId,
        kind: "attempt",
        status: attempt.includes("item-c") || options.blockedStageIds.includes(stageId) ? "blocked" : "completed",
        path: itemId ? path.join("attempts", stageId, `item-${itemId}`, "attempt-1") : path.join("attempts", stageId, "attempt-1"),
        parseErrorCode: "OK",
        blockedReason: attempt.includes("item-c") || options.blockedStageIds.includes(stageId) ? (options.blockedReason ?? "item blocked") : undefined
      }];
    })),
    agentUsage: options.agentUsage,
    gateVerdict: options.gateVerdict,
    blockedReason: options.blockedReason
  };
  await writeRunIndex(options.cwd, index);
  await fs.writeFile(path.join(dir, "run.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

function attemptIdFromFixture(value: string): string {
  const [stageId, itemSuffix] = value.split(":item-");
  return itemSuffix ? `${stageId}:item-${itemSuffix}:attempt-1` : `${stageId}:attempt-1`;
}

function validation(summary: string): Record<string, unknown> {
  return { status: "completed", summary, artifacts: [], nextFocus: "gate", verdict: "pass", severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, findings: [], checks: [] };
}
