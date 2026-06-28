import type { Writable } from "node:stream";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core";

export type ResultPhase = "usage" | "typecheck" | "compile" | "validate" | "dry-run" | "run" | "status" | "control" | "fork" | "replay";

export type WorkflowSummary = {
  name: string;
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

export type RuntimeRunSummary = {
  runId: string;
  workflowName: string;
  status: string;
  admittedAt: string;
  startedAt?: string;
  endedAt?: string;
  runDir?: string;
};

export type CliResult = {
  ok: boolean;
  phase: ResultPhase;
  message?: string;
  workflow?: WorkflowSummary;
  diagnostics?: DiagnosticIR[];
  typecheck?: { exitCode: number | null; stdout: string; stderr: string };
  preflightDir?: string;
  irDigest?: string;
  taskBundleCount?: number;
  sourceGraphDigest?: string;
  runId?: string;
  status?: string;
  runDir?: string;
  output?: unknown;
  error?: unknown;
  runs?: RuntimeRunSummary[];
  nodes?: unknown[];
  artifacts?: unknown[];
  replay?: unknown;
  forkedFrom?: string;
};

export type OutputFormat = "text" | "json";

export function writeResult(result: CliResult, format: OutputFormat, streams: { stdout: Writable; stderr: Writable }, exitCode: number): number {
  if (format === "json") {
    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
  }

  const stream = result.ok ? streams.stdout : streams.stderr;
  stream.write(`${result.message ?? (result.ok ? "OK" : "Failed")}\n`);
  if (result.workflow) {
    stream.write(`Workflow: ${result.workflow.name}\n`);
    stream.write(`IR version: ${result.workflow.irVersion}\n`);
    stream.write(`Nodes: ${result.workflow.nodeCount}\n`);
    stream.write(`Outputs: ${result.workflow.outputKeys.length ? result.workflow.outputKeys.join(", ") : "(none)"}\n`);
    stream.write(`Diagnostics: ${result.workflow.diagnostics.errors} errors, ${result.workflow.diagnostics.warnings} warnings, ${result.workflow.diagnostics.infos} infos\n`);
  }
  if (result.preflightDir) stream.write(`Preflight: ${result.preflightDir}\n`);
  if (result.irDigest) stream.write(`IR digest: ${result.irDigest}\n`);
  if (result.sourceGraphDigest) stream.write(`Source graph digest: ${result.sourceGraphDigest}\n`);
  if (result.taskBundleCount !== undefined) stream.write(`Task bundles: ${result.taskBundleCount}\n`);
  if (result.runId) stream.write(`Run: ${result.runId}\n`);
  if (result.status) stream.write(`Status: ${result.status}\n`);
  if (result.runDir) stream.write(`Run dir: ${result.runDir}\n`);
  if (result.forkedFrom) stream.write(`Forked from: ${result.forkedFrom}\n`);
  if (result.runs?.length) {
    stream.write("\nRuns:\n");
    for (const run of result.runs) {
      stream.write(`- ${run.runId} ${run.status} ${run.workflowName} admitted=${run.admittedAt}${run.endedAt ? ` ended=${run.endedAt}` : ""}\n`);
    }
  }
  if (result.nodes?.length) {
    stream.write("\nNodes:\n");
    for (const node of result.nodes) stream.write(`${JSON.stringify(node)}\n`);
  }
  if (result.artifacts?.length) {
    stream.write("\nArtifacts:\n");
    for (const artifact of result.artifacts) stream.write(`${JSON.stringify(artifact)}\n`);
  }
  if (result.output !== undefined) stream.write(`\nOutput:\n${JSON.stringify(result.output, null, 2)}\n`);
  if (result.error !== undefined) stream.write(`\nError:\n${JSON.stringify(result.error, null, 2)}\n`);
  if (result.replay !== undefined) stream.write(`\nReplay:\n${JSON.stringify(result.replay, null, 2)}\n`);
  if (result.typecheck) {
    if (result.typecheck.stdout) stream.write(`\n${result.typecheck.stdout}`);
    if (result.typecheck.stderr) stream.write(`\n${result.typecheck.stderr}`);
  }
  if (result.diagnostics?.length) {
    for (const diagnostic of result.diagnostics) {
      stream.write(`[${diagnostic.severity}] ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}\n`);
    }
  }
  return exitCode;
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
    irVersion: ir.irVersion,
    nodeCount: countNodes(ir.root),
    outputKeys: Object.keys(ir.outputs).sort(),
    diagnostics,
  };
}

function countNodes(scope: WorkflowIR["root"]): number {
  let total = scope.nodes.length;
  for (const node of scope.nodes) {
    if (node.kind === "if") {
      total += countNodes(node.then);
      if (node.else) total += countNodes(node.else);
    } else if (node.kind === "switch") {
      for (const c of node.cases) total += countNodes(c.then);
      if (node.default) total += countNodes(node.default);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) total += countNodes(branch.scope);
    } else if (node.kind === "fanout") {
      total += countNodes(node.do);
    } else if (node.kind === "loop") {
      total += countNodes(node.do);
    }
  }
  return total;
}
