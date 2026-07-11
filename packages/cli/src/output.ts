import type { Writable } from "node:stream";
import { walkNodes, type DiagnosticIR, type WorkflowIR } from "@acpus/core/ir";
import type { HookConfigScope, LoadedHookConfig, RunDetails, RunRecord, RuntimeHealthCheck } from "@acpus/runtime";
import { formatAgentProgressLines } from "./agent-progress-format.js";
import type { WorkflowCatalogEntry } from "./catalog.js";
import type { InitTarget } from "./workflow-init/types.js";

export type ResultPhase = "usage" | "check" | "compile" | "validate" | "run" | "inspect" | "control" | "delete" | "doctor" | "viz" | "skill" | "init";

export type WorkflowSummary = {
  name: string;
  description?: string;
  irVersion: number;
  nodeCount: number;
  outputKeys: string[];
  diagnostics: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
  };
};

export type CliResult = {
  ok: boolean;
  phase: ResultPhase;
  message?: string;
  workflow?: WorkflowSummary;
  diagnostics?: DiagnosticIR[];
  sourceGraphDigest?: string;
  run?: RunRecord | RunDetails;
  runs?: RunRecord[];
  deletedRuns?: RunRecord[];
  skippedRuns?: RunRecord[];
  list?: { total: number; limit?: number; truncated: boolean; order: "updatedAt DESC" };
  catalog?: WorkflowCatalogEntry;
  catalogEntries?: WorkflowCatalogEntry[];
  forkRunId?: string;
  followRunId?: string;
  checks?: RuntimeHealthCheck[];
  errorCode?: string;
  control?: { type: string; runId: string };
  hookValidation?: { count: number };
  hooks?: HookListResult;
  outputPath?: string;
  target?: InitTarget;
  path?: string;
  skill?: SkillCommandResult;
};

export type HookListResult = Partial<Record<HookConfigScope["source"], { path: string; hooks: LoadedHookConfig[] }>>;

export type SkillCommandResult = {
  action: "install" | "uninstall";
  packageName: string;
  skillName: string;
  targetName: string;
  scope: "project" | "global";
  dryRun: boolean;
  targets: {
    scope: "project" | "global";
    kind: "agents" | "claude";
    rootPath: string;
    targetPath: string;
  }[];
  installations?: {
    scope: "project" | "global";
    kind: "agents" | "claude";
    targetPath: string;
    status: "installed" | "updated" | "would-install" | "would-update" | "skipped" | "failed";
    error?: string;
  }[];
  removals?: {
    scope: "project" | "global";
    kind: "agents" | "claude";
    targetPath: string;
    status: "removed" | "would-remove" | "missing" | "skipped" | "failed";
    error?: string;
  }[];
};

export type OutputFormat = "text" | "json";

export function writeResult(result: CliResult, format: OutputFormat, streams: { stdout: Writable; stderr: Writable }, exitCode: number): number {
  if (format === "json") {
    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
  }

  const stream = result.ok ? streams.stdout : streams.stderr;
  if (!result.hooks && result.phase !== "init") stream.write(`${result.message ?? (result.ok ? "OK" : "Failed")}\n`);
  if (result.workflow) {
    stream.write(`Workflow: ${result.workflow.name}\n`);
    if (result.workflow.description) stream.write(`Description: ${result.workflow.description}\n`);
    stream.write(`IR version: ${result.workflow.irVersion}\n`);
    stream.write(`Static nodes: ${result.workflow.nodeCount}\n`);
    stream.write(`Outputs: ${result.workflow.outputKeys.length ? result.workflow.outputKeys.join(", ") : "(none)"}\n`);
    stream.write(`Diagnostics: ${result.workflow.diagnostics.errors} errors, ${result.workflow.diagnostics.warnings} warnings, ${result.workflow.diagnostics.infos} infos\n`);
  }
  if (result.catalog) writeCatalogEntry(stream, result.catalog);
  if (result.catalogEntries) {
    if (result.catalogEntries.length === 0) {
      stream.write("No cataloged workflows.\n");
    } else {
      for (const entry of result.catalogEntries) {
        stream.write(`${entry.scope}\t${entry.status}\t${entry.requiresScope ? "requires-scope" : "ready"}\t${entry.name}\t${entry.entryPath}\n`);
      }
    }
  }
  if (result.run) {
    stream.write(`Run: ${result.run.id}\n`);
    stream.write(`Status: ${result.run.status}\n`);
    stream.write(`Workflow entry: ${result.run.workflowEntry}\n`);
    if ("eventCount" in result.run) {
      stream.write(`Events: ${result.run.eventCount}\n`);
      stream.write(`Nodes: ${result.run.nodeCount}\n`);
      if (result.run.output !== undefined) stream.write(`Output: ${previewJson(result.run.output)}\n`);
      if (result.run.dynamic) writeCompactDynamicSummary(stream, result.run);
    }
  }
  if (result.errorCode) stream.write(`Error code: ${result.errorCode}\n`);
  if (result.control) stream.write(`Control: ${result.control.type} ${result.control.runId}\n`);
  if (result.outputPath) stream.write(`Output: ${result.outputPath}\n`);
  if (result.phase === "init" && result.path) {
    stream.write(`Path: ${result.path}\n`);
    stream.write(`Next: acpus workflow check ${result.path}\n`);
  }
  if (result.runs) {
    if (result.runs.length === 0) {
      stream.write("No runs.\n");
    } else {
      for (const run of result.runs) {
        stream.write(`${run.id}\t${run.status}\t${run.updatedAt}\t${run.name}\t${run.workflowEntry}\n`);
      }
      if (result.list?.truncated) stream.write(`showing ${result.runs.length} of ${result.list.total}\n`);
    }
  }
  if (result.deletedRuns) {
    for (const run of result.deletedRuns) stream.write(`Deleted: ${run.id}\t${run.status}\t${run.name}\n`);
  }
  if (result.skippedRuns?.length) {
    for (const run of result.skippedRuns) stream.write(`Skipped: ${run.id}\t${run.status}\t${run.name}\n`);
  }
  if (result.forkRunId) stream.write(`Fork run: ${result.forkRunId}\n`);
  if (result.followRunId) stream.write(`Next: acpus runs inspect ${result.followRunId} --follow\n`);
  if (result.checks) {
    for (const check of result.checks) stream.write(`${check.status}\t${check.area}\t${check.message}\n`);
  }
  if (result.hooks) writeHooks(stream, result.hooks);
  if (result.skill) writeSkillResult(stream, result.skill);
  if (result.diagnostics?.length) {
    for (const diagnostic of result.diagnostics) {
      stream.write(`[${diagnostic.severity}] ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}\n`);
      if (diagnostic.source) stream.write(`  source: ${diagnostic.source.file}:${diagnostic.source.line}:${diagnostic.source.column}\n`);
      if (diagnostic.hint) stream.write(`  hint: ${diagnostic.hint}\n`);
    }
  }
  return exitCode;
}

function writeSkillResult(stream: Writable, result: SkillCommandResult): void {
  stream.write(`Skill: ${result.packageName}/${result.skillName}\n`);
  stream.write(`Target: ${result.targetName}\n`);
  stream.write(`Scope: ${result.scope}\n`);
  if (result.installations) {
    for (const installation of result.installations) {
      stream.write(`${installation.status}\t${installation.kind}\t${installation.targetPath}${installation.error ? `\t${installation.error}` : ""}\n`);
    }
  }
  if (result.removals) {
    for (const removal of result.removals) {
      stream.write(`${removal.status}\t${removal.kind}\t${removal.targetPath}${removal.error ? `\t${removal.error}` : ""}\n`);
    }
  }
}

function writeHooks(stream: Writable, scopes: HookListResult): void {
  stream.write(scopes.project && scopes.global ? "Hooks (project + global):\n\n" : "Hooks:\n\n");
  if (scopes.project) writeHookScope(stream, "Project", scopes.project);
  if (scopes.project && scopes.global) stream.write("\n");
  if (scopes.global) writeHookScope(stream, "Global", scopes.global);
}

function writeHookScope(stream: Writable, label: "Project" | "Global", scope: NonNullable<HookListResult["project"]>): void {
  stream.write(`${label}: ${scope.path}\n`);
  if (scope.hooks.length === 0) {
    stream.write("  (none)\n");
    return;
  }
  const byEvent = new Map<string, LoadedHookConfig[]>();
  for (const hook of scope.hooks) byEvent.set(hook.event, [...(byEvent.get(hook.event) ?? []), hook]);
  for (const [event, hooks] of byEvent) {
    stream.write(`  ${event}\n`);
    for (const hook of hooks) {
      const match = hook.match ? `  (match: ${Object.entries(hook.match).map(([key, value]) => `${key}=${value}`).join(", ")})` : "";
      stream.write(`    ${hook.id ?? hook.effectiveId}  ->  ${hook.command}${match}\n`);
    }
  }
}

function writeCatalogEntry(stream: Writable, entry: WorkflowCatalogEntry): void {
  stream.write(`Catalog: ${entry.scope}/${entry.name}\n`);
  stream.write(`Catalog status: ${entry.status}${entry.requiresScope ? " (requires --project or --global when unscoped)" : ""}\n`);
  stream.write(`Catalog package: ${entry.packagePath}\n`);
  stream.write(`Catalog entry: ${entry.entryPath}\n`);
}

export function writeJsonLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function previewJson(value: unknown): string {
  const raw = JSON.stringify(value);
  if (raw.length <= 500) return raw;
  return `${raw.slice(0, 500)}... (${raw.length - 500} bytes omitted)`;
}

function writeCompactDynamicSummary(stream: Writable, run: RunDetails): void {
  const dynamic = run.dynamic;
  if (!dynamic) return;
  for (const wait of dynamic.signalWaits.filter(wait => wait.status === "awaiting").slice(0, 20)) {
    stream.write(`Awaiting signal: ${wait.nodeKey}\n`);
    stream.write(`Use: acpus runs signal ${run.id} --target ${wait.nodeKey} --payload '<json>'\n`);
  }
  const actionable = dynamic.nodeInstances.filter(node => node.status !== "completed")
    .map(node => `${node.nodeKey} ${node.status}`)
    .slice(0, 20);
  if (actionable.length > 0) stream.write(`Actionable nodes: ${actionable.join(", ")}\n`);
  const omitted = dynamic.nodeInstances.length - actionable.length;
  if (omitted > 0) stream.write(`Node details omitted: ${omitted}\n`);
  const signalWaitsOmitted = Math.max(0, dynamic.signalWaits.length - 20);
  if (signalWaitsOmitted > 0) stream.write(`Signal waits omitted: ${signalWaitsOmitted}\n`);
  for (const progress of dynamic.progress.filter(progress => progress.kind === "agent").slice(-5)) {
    for (const line of formatAgentProgressLines(progress)) stream.write(`${line}\n`);
  }
  const agentAttempts = dynamic.executionMetadata.filter(entry => entry.kind === "agent_attempt").length;
  if (agentAttempts > 0) stream.write(`Agent attempt details omitted: ${agentAttempts}. Use --json for full metadata.\n`);
}

export function summarizeWorkflow(ir: WorkflowIR): WorkflowSummary {
  const diagnostics = {
    total: ir.diagnostics.length,
    errors: ir.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
    warnings: ir.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
    infos: ir.diagnostics.filter(diagnostic => diagnostic.severity === "info").length,
  };
  return {
    name: ir.name,
    ...(ir.description === undefined ? {} : { description: ir.description }),
    irVersion: ir.irVersion,
    nodeCount: Array.from(walkNodes(ir.root)).length,
    outputKeys: Object.keys(ir.outputs).sort(),
    diagnostics,
  };
}
