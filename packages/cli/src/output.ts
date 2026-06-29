import type { Writable } from "node:stream";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core";
import type { ReplayResult, RunDetails, RunRecord, RuntimeCommandRecord } from "@acpus/runtime";

export type ResultPhase = "usage" | "typecheck" | "compile" | "validate" | "dry-run" | "admit" | "inspect";

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
  run?: RunRecord | RunDetails;
  runs?: RunRecord[];
  replay?: ReplayResult;
  command?: RuntimeCommandRecord;
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
  if (result.run) {
    stream.write(`Run: ${result.run.id}\n`);
    stream.write(`Status: ${result.run.status}\n`);
    stream.write(`Workflow entry: ${result.run.workflowEntry}\n`);
    if ("eventCount" in result.run) {
      stream.write(`Events: ${result.run.eventCount}\n`);
      stream.write(`Nodes: ${result.run.nodeCount}\n`);
      stream.write(`Task bundles: ${result.run.taskBundleCount}\n`);
      if (result.run.output !== undefined) stream.write(`Output: ${JSON.stringify(result.run.output)}\n`);
    }
  }
  if (result.runs) {
    if (result.runs.length === 0) {
      stream.write("No runs.\n");
    } else {
      for (const run of result.runs) {
        stream.write(`${run.id}\t${run.status}\t${run.name}\t${run.workflowEntry}\n`);
      }
    }
  }
  if (result.replay) {
    stream.write(`Replay: ${result.replay.ok ? "matched" : "did not match"}\n`);
    if (result.replay.artifacts) {
      stream.write(`Artifacts checked: ${result.replay.artifacts.checked}\n`);
      for (const artifact of result.replay.artifacts.missing) stream.write(`Missing artifact: ${artifact.id} ${artifact.relativePath}\n`);
      for (const artifact of result.replay.artifacts.invalid) stream.write(`Invalid artifact: ${artifact.id} ${artifact.relativePath} ${artifact.message}\n`);
      for (const artifact of result.replay.artifacts.mismatched) stream.write(`Mismatched artifact: ${artifact.id} ${artifact.relativePath}\n`);
    }
    if (result.replay.projection) {
      for (const issue of result.replay.projection.issues) stream.write(`Projection issue: ${issue}\n`);
    }
  }
  if (result.command) stream.write(`Command: ${result.command.id}\t${result.command.type}\t${result.command.status}\n`);
  if (result.irDigest) stream.write(`IR digest: ${result.irDigest}\n`);
  if (result.taskBundleCount !== undefined) stream.write(`Task bundles: ${result.taskBundleCount}\n`);
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
