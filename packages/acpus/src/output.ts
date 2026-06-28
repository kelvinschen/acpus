import type { Writable } from "node:stream";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core";

export type ResultPhase = "usage" | "typecheck" | "compile" | "validate" | "dry-run";

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
