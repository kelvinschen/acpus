import type { Writable } from "node:stream";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core/ir";
import type { ReplayResult, RunDetails, RunRecord, RuntimeCommandRecord } from "@acpus/runtime";

export type ResultPhase = "usage" | "check" | "compile" | "validate" | "dry-run" | "admit" | "inspect";

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
      writeAgentExecutionMetadata(stream, result.run);
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
  if (result.diagnostics?.length) {
    for (const diagnostic of result.diagnostics) {
      stream.write(`[${diagnostic.severity}] ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}\n`);
      if (diagnostic.source) stream.write(`  source: ${diagnostic.source.file}:${diagnostic.source.line}:${diagnostic.source.column}\n`);
      if (diagnostic.hint) stream.write(`  hint: ${diagnostic.hint}\n`);
    }
  }
  return exitCode;
}

function writeAgentExecutionMetadata(stream: Writable, run: RunDetails): void {
  const attempts = run.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt") ?? [];
  if (attempts.length === 0) return;
  stream.write("Agent attempts:\n");
  for (const attempt of attempts) {
    const metadata = agentAttemptMetadata(attempt.metadata);
    stream.write(`  ${metadata.nodeKey ?? metadata.nodeId ?? "(agent)"} attempt ${metadata.attemptNo ?? "?"}: ${metadata.status ?? "unknown"}\n`);
    if (metadata.message) stream.write(`    message: ${metadata.message}\n`);
    if (metadata.sessionName) stream.write(`    session: ${metadata.sessionName}\n`);
    if (metadata.sessionKey) stream.write(`    session key: ${metadata.sessionKey}\n`);
    for (const turn of metadata.turns ?? []) {
      stream.write(`    turn ${turn.turn ?? "?"}: ${turn.status ?? "unknown"}${turn.failureKind ? ` ${turn.failureKind}` : ""}\n`);
      if (turn.message) stream.write(`      message: ${turn.message}\n`);
      for (const line of agentTurnTelemetryLines(turn.telemetry)) stream.write(`      ${line}\n`);
      for (const [label, ref] of agentTurnArtifactRefs(turn)) {
        stream.write(`      ${label}: ${ref.relativePath}\n`);
      }
    }
  }
}

type AgentAttemptOutputMetadata = {
  nodeId?: string;
  nodeKey?: string;
  attemptNo?: number;
  status?: string;
  message?: string;
  sessionName?: string;
  sessionKey?: string;
  turns?: AgentTurnOutputMetadata[];
};

type AgentTurnOutputMetadata = {
  turn?: number;
  status?: string;
  failureKind?: string;
  message?: string;
  telemetry?: AgentTurnTelemetryOutputMetadata;
  promptArtifact?: AgentArtifactOutputRef;
  responseArtifact?: AgentArtifactOutputRef;
  stderrArtifact?: AgentArtifactOutputRef;
  telemetryArtifact?: AgentArtifactOutputRef;
  rawRecoveredOutputArtifact?: AgentArtifactOutputRef;
  rawAcpDebugArtifact?: AgentArtifactOutputRef;
};

type AgentTurnTelemetryOutputMetadata = {
  context?: { used?: number; size?: number };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  tools?: { totalToolCallCount?: number };
};

type AgentArtifactOutputRef = {
  relativePath: string;
};

function agentAttemptMetadata(value: unknown): AgentAttemptOutputMetadata {
  if (!isObject(value)) return {};
  return withoutUndefined({
    nodeId: stringField(value, "nodeId"),
    nodeKey: stringField(value, "nodeKey"),
    attemptNo: numberField(value, "attemptNo"),
    status: stringField(value, "status"),
    message: stringField(value, "message"),
    sessionName: stringField(value, "sessionName"),
    sessionKey: stringField(value, "sessionKey"),
    turns: Array.isArray(value.turns) ? value.turns.map(agentTurnMetadata) : undefined,
  }) as AgentAttemptOutputMetadata;
}

function agentTurnMetadata(value: unknown): AgentTurnOutputMetadata {
  if (!isObject(value)) return {};
  return withoutUndefined({
    turn: numberField(value, "turn"),
    status: stringField(value, "status"),
    failureKind: stringField(value, "failureKind"),
    message: stringField(value, "message"),
    telemetry: agentTelemetry(value.telemetry),
    promptArtifact: artifactRef(value.promptArtifact),
    responseArtifact: artifactRef(value.responseArtifact),
    stderrArtifact: artifactRef(value.stderrArtifact),
    telemetryArtifact: artifactRef(value.telemetryArtifact),
    rawRecoveredOutputArtifact: artifactRef(value.rawRecoveredOutputArtifact),
    rawAcpDebugArtifact: artifactRef(value.rawAcpDebugArtifact),
  }) as AgentTurnOutputMetadata;
}

function agentTelemetry(value: unknown): AgentTurnTelemetryOutputMetadata | undefined {
  if (!isObject(value)) return undefined;
  const context = isObject(value.context) ? withoutUndefined({
    used: numberField(value.context, "used"),
    size: numberField(value.context, "size"),
  }) : undefined;
  const tokenUsage = isObject(value.tokenUsage) ? withoutUndefined({
    inputTokens: numberField(value.tokenUsage, "inputTokens"),
    outputTokens: numberField(value.tokenUsage, "outputTokens"),
    cachedReadTokens: numberField(value.tokenUsage, "cachedReadTokens"),
    cachedWriteTokens: numberField(value.tokenUsage, "cachedWriteTokens"),
    thoughtTokens: numberField(value.tokenUsage, "thoughtTokens"),
    totalTokens: numberField(value.tokenUsage, "totalTokens"),
  }) : undefined;
  const tools = isObject(value.tools) ? withoutUndefined({
    totalToolCallCount: numberField(value.tools, "totalToolCallCount"),
  }) : undefined;
  const metadata = withoutUndefined({
    context: context && Object.keys(context).length > 0 ? context : undefined,
    tokenUsage: tokenUsage && Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined,
    tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
  });
  return Object.keys(metadata).length > 0 ? metadata as AgentTurnTelemetryOutputMetadata : undefined;
}

function agentTurnTelemetryLines(telemetry: AgentTurnTelemetryOutputMetadata | undefined): string[] {
  if (!telemetry) return [];
  return [
    telemetry.context?.used !== undefined || telemetry.context?.size !== undefined
      ? `context: ${telemetry.context.used ?? "?"}/${telemetry.context.size ?? "?"}`
      : undefined,
    tokenUsageLine(telemetry.tokenUsage),
    telemetry.tools?.totalToolCallCount !== undefined ? `tools: ${telemetry.tools.totalToolCallCount}` : undefined,
  ].filter((line): line is string => line !== undefined);
}

function tokenUsageLine(usage: AgentTurnTelemetryOutputMetadata["tokenUsage"]): string | undefined {
  if (!usage) return undefined;
  const parts = [
    ["input", usage.inputTokens],
    ["output", usage.outputTokens],
    ["cache_read", usage.cachedReadTokens],
    ["cache_write", usage.cachedWriteTokens],
    ["thought", usage.thoughtTokens],
    ["total", usage.totalTokens],
  ].filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([label, value]) => `${label}=${value}`);
  return parts.length ? `tokens: ${parts.join(" ")}` : undefined;
}

function agentTurnArtifactRefs(turn: AgentTurnOutputMetadata): Array<[string, AgentArtifactOutputRef]> {
  return [
    ["prompt", turn.promptArtifact],
    ["response", turn.responseArtifact],
    ["stderr", turn.stderrArtifact],
    ["telemetry", turn.telemetryArtifact],
    ["raw output", turn.rawRecoveredOutputArtifact],
    ["raw acp", turn.rawAcpDebugArtifact],
  ].filter((entry): entry is [string, AgentArtifactOutputRef] => entry[1] !== undefined);
}

function artifactRef(value: unknown): AgentArtifactOutputRef | undefined {
  if (!isObject(value) || typeof value.relativePath !== "string") return undefined;
  return { relativePath: value.relativePath };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
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
