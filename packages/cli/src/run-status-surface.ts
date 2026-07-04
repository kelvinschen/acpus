import type { NodeIR, SchemaIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import type { RunDetails, RunDynamicAttempt, RunDynamicFrame, RunDynamicNodeInstance, RunDynamicSignalWait } from "@acpus/runtime";

export type RunStatusStaticNode = {
  nodeId: string;
  kind: NodeIR["kind"];
  order: number;
  outputSchema?: SchemaIR;
};

type StaticIndex = {
  orderByNodeId: Map<string, number>;
  nodeById: Map<string, RunStatusStaticNode>;
};

type Row = {
  key: string;
  nodeId: string;
  kind: NodeIR["kind"];
  status: string;
  start?: string;
  end?: string;
  attemptNo?: number;
  error?: unknown;
  signalWait?: RunDynamicSignalWait;
};

export function staticNodesForWorkflow(ir: WorkflowIR): RunStatusStaticNode[] {
  const nodes: RunStatusStaticNode[] = [];
  visitScope(ir.root, nodes);
  return nodes;
}

export function formatRunStatusSurface(run: RunDetails, staticNodes: readonly RunStatusStaticNode[] = [], nowMs = Date.now()): string {
  const index = staticIndex(staticNodes);
  const lines = [`Run ${run.id}  ${run.name}  ${displayRunExecutionStatus(run)}  ${formatRunDuration(run, nowMs)}`];
  const rows = statusRows(run, staticNodes, index);
  for (const row of rows) {
    lines.push(...formatRow(row, run.id, nowMs, index));
  }
  const output = formatOutput(run);
  if (output) {
    lines.push("");
    lines.push(...output);
  }
  const hooks = formatHooks(run);
  if (hooks) {
    lines.push("");
    lines.push(...hooks);
  }
  return `${lines.join("\n")}\n`;
}

function displayRunExecutionStatus(run: RunDetails): string {
  if (run.execution?.state !== "stale") return run.status;
  if (run.execution.reason === "daemon_pid_dead") return `stale (daemon pid dead, last status: ${run.status})`;
  if (run.execution.reason === "run_lease_expired") return `stale (run lease expired, last status: ${run.status})`;
  return `stale (daemon heartbeat expired, last status: ${run.status})`;
}

export function formatRunObservationRow(run: RunDetails, nodeKey: string, nowMs = Date.now(), staticNodes: readonly RunStatusStaticNode[] = []): string | undefined {
  const index = staticIndex(staticNodes);
  const row = statusRows(run, staticNodes, index).find(candidate => candidate.key === nodeKey);
  if (row) return formatRow(row, run.id, nowMs, index).join("\n");
  const frame = run.dynamic?.frames.find(candidate => candidate.frameKey === nodeKey);
  if (frame?.nodeId) {
    return formatRow({
      key: frame.frameKey,
      nodeId: frame.nodeId,
      kind: nodeKind(index, frame.nodeId) ?? "assert",
      status: frame.status,
      start: frame.createdAt,
      ...endField(terminalStatus(frame.status) ? frame.updatedAt : undefined),
      ...errorField(frame.error),
    }, run.id, nowMs, index).join("\n");
  }
  const instance = run.dynamic?.nodeInstances.find(candidate => candidate.nodeKey === nodeKey);
  if (!instance) return undefined;
  const attempt = currentAttempt(run.dynamic?.attempts ?? [], instance);
  return formatRow({
    key: instance.nodeKey,
    nodeId: instance.nodeId,
    kind: nodeKind(index, instance.nodeId) ?? "task",
    status: instance.status,
    start: attempt?.startedAt ?? instance.createdAt,
    ...endField(attempt?.finishedAt ?? (terminalStatus(instance.status) ? instance.updatedAt : undefined)),
    ...(attempt?.attemptNo === undefined ? {} : { attemptNo: attempt.attemptNo }),
    ...errorField(instance.error ?? attempt?.error),
  }, run.id, nowMs, index).join("\n");
}

function statusRows(run: RunDetails, staticNodes: readonly RunStatusStaticNode[], index: StaticIndex): Row[] {
  const rows: Row[] = [];
  const materializedNodeIds = new Set([
    ...(run.dynamic?.frames.flatMap(frame => frame.nodeId ? [frame.nodeId] : []) ?? []),
    ...(run.dynamic?.nodeInstances.map(instance => instance.nodeId) ?? []),
  ]);

  for (const frame of run.dynamic?.frames ?? []) {
    if (!frame.nodeId || (frame.frameKind !== "node" && frame.frameKind !== "loop")) continue;
    const kind = nodeKind(index, frame.nodeId) ?? "assert";
    if (frame.status === "completed" && kind !== "assert") continue;
    rows.push({
      key: frame.frameKey,
      nodeId: frame.nodeId,
      kind,
      status: frame.status,
      start: frame.createdAt,
      ...(terminalStatus(frame.status) ? { end: frame.updatedAt } : {}),
      ...(frame.error === undefined ? {} : { error: frame.error }),
    });
  }

  for (const instance of run.dynamic?.nodeInstances ?? []) {
    const attempt = currentAttempt(run.dynamic?.attempts ?? [], instance);
    const signalWait = run.dynamic?.signalWaits.find(wait => wait.nodeKey === instance.nodeKey && wait.status === "awaiting");
    rows.push({
      key: instance.nodeKey,
      nodeId: instance.nodeId,
      kind: nodeKind(index, instance.nodeId) ?? "task",
      status: signalWait?.status ?? instance.status,
      start: attempt?.startedAt ?? signalWait?.createdAt ?? instance.createdAt,
      ...endField(attempt?.finishedAt ?? (terminalStatus(instance.status) ? instance.updatedAt : undefined)),
      ...(attempt?.attemptNo === undefined ? {} : { attemptNo: attempt.attemptNo }),
      ...errorField(instance.error ?? attempt?.error),
      ...(signalWait === undefined ? {} : { signalWait }),
    });
  }

  if (!terminalRunStatus(run.status)) {
    for (const item of staticNodes) {
      if (materializedNodeIds.has(item.nodeId)) continue;
      rows.push({
        key: item.nodeId,
        nodeId: item.nodeId,
        kind: item.kind,
        status: "pending",
      });
    }
  }

  return rows.sort((left, right) => {
    const order = (index.orderByNodeId.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) - (index.orderByNodeId.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER);
    return order || left.key.localeCompare(right.key);
  });
}

function formatRow(row: Row, runId: string, nowMs: number, index: StaticIndex): string[] {
  const parts = [row.key, `[${row.kind}]`];
  if (row.status !== "completed") parts.push(displayStatus(row.status));
  const duration = formatDuration(row.start, row.end, row.status, nowMs);
  if (duration) parts.push(duration);
  if ((row.attemptNo ?? 1) > 1) parts.push(`attempt=${row.attemptNo}`);

  const lines = [`  ${statusGlyph(row.status)} ${parts.join("  ")}`];
  const error = errorMessage(row.error);
  if (error) lines.push(`    Error: ${error}`);
  if (row.signalWait?.status === "awaiting") {
    lines.push(...formatSignalWait(runId, row.signalWait, index.nodeById.get(row.nodeId)?.outputSchema));
  }
  return lines;
}

function formatSignalWait(runId: string, wait: RunDynamicSignalWait, outputSchema: SchemaIR | undefined): string[] {
  const lines: string[] = [];
  if (wait.renderedPrompt) {
    lines.push("    Prompt:");
    for (const line of wait.renderedPrompt.replace(/\s+$/, "").split("\n")) lines.push(`      ${line}`);
  }
  lines.push(...payloadGuidance(outputSchema).map(line => `    ${line}`));
  lines.push(`    Signal: acpus runs signal ${runId} --target ${wait.nodeKey} --payload '<json>'`);
  return lines;
}

function payloadGuidance(schema: SchemaIR | undefined): string[] {
  if (!schema) return ["Expected payload: string"];
  if (schema.kind !== "object") return [`Expected payload: ${schemaKind(schema)}`];
  const fields = Object.entries(schema.fields);
  if (fields.length === 0) return ["Expected payload: {}"];
  const required = new Set(schema.required);
  return [
    "Expected payload:",
    ...fields.map(([name, field]) => `  ${name}: ${schemaKind(field)}${required.has(name) ? " (required)" : " (optional)"}`),
  ];
}

function schemaKind(schema: SchemaIR): string {
  if (schema.kind === "array") return `${schemaKind(schema.item)}[]`;
  if (schema.kind === "union") return schema.variants.map(schemaKind).join(" | ");
  if (schema.kind === "literal") return JSON.stringify(schema.value);
  if (schema.kind === "enum") return schema.values.map(value => JSON.stringify(value)).join(" | ");
  if (schema.kind === "record") return `record<${schemaKind(schema.value)}>`;
  return schema.kind;
}

function formatOutput(run: RunDetails): string[] | undefined {
  if (run.status !== "completed" || run.output === undefined || emptyObject(run.output)) return undefined;
  return ["Output:", ...JSON.stringify(run.output, null, 2).split("\n").map(line => `  ${line}`)];
}

function formatHooks(run: RunDetails): string[] | undefined {
  if (!terminalRunStatus(run.status) || run.hooks.length === 0) return undefined;
  return [
    "Hooks:",
    ...run.hooks.map(entry => {
      const duration = entry.durationMs === undefined ? "" : `  ${formatMs(entry.durationMs)}`;
      const exit = entry.exitCode === undefined ? "" : `  exit=${entry.exitCode}`;
      return `  ${entry.status}  ${entry.handlerId}  ${entry.event}  #${entry.eventSequence}${duration}${exit}`;
    }),
  ];
}

function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function formatRunDuration(run: RunDetails, nowMs: number): string {
  return formatDuration(run.createdAt, terminalRunStatus(run.status) ? run.updatedAt : undefined, run.status, nowMs) ?? "<1s";
}

function formatDuration(start: string | undefined, end: string | undefined, status: string, nowMs: number): string | undefined {
  if (!start) return undefined;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return undefined;
  const endMs = end ? Date.parse(end) : activeStatus(status) ? nowMs : undefined;
  if (endMs === undefined || !Number.isFinite(endMs)) return undefined;
  const seconds = Math.floor(Math.max(0, endMs - startMs) / 1000);
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function latestAttempt(attempts: RunDynamicAttempt[], nodeKey: string): RunDynamicAttempt | undefined {
  return attempts.filter(attempt => attempt.nodeKey === nodeKey).sort((left, right) => right.attemptNo - left.attemptNo)[0];
}

function currentAttempt(attempts: RunDynamicAttempt[], instance: RunDynamicNodeInstance): RunDynamicAttempt | undefined {
  if (instance.acceptedAttemptId) return attempts.find(attempt => attempt.attemptId === instance.acceptedAttemptId);
  if (instance.status === "ready" || instance.status === "awaiting") return undefined;
  return latestAttempt(attempts, instance.nodeKey);
}

function endField(end: string | undefined): Pick<Row, "end"> | {} {
  return end === undefined ? {} : { end };
}

function errorField(error: unknown): Pick<Row, "error"> | {} {
  return error === undefined ? {} : { error };
}

function statusGlyph(status: string): string {
  if (status === "pending" || status === "ready") return "○";
  if (status === "running" || status === "started") return "⠋";
  if (status === "awaiting") return "◌";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "paused") return "Ⅱ";
  if (status === "canceled" || status === "cancelled") return "·";
  return "?";
}

function displayStatus(status: string): string {
  return status === "cancelled" ? "canceled" : status;
}

function terminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function terminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled" || status === "cancelled" || status === "timed_out";
}

function activeStatus(status: string): boolean {
  return status === "running" || status === "started" || status === "awaiting" || status === "pending" || status === "ready" || status === "paused";
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  if (typeof error === "object" && "reason" in error && typeof (error as { reason?: unknown }).reason === "string") return (error as { reason: string }).reason;
  return JSON.stringify(error);
}

function emptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function staticIndex(staticNodes: readonly RunStatusStaticNode[]): StaticIndex {
  return {
    orderByNodeId: new Map(staticNodes.map(item => [item.nodeId, item.order])),
    nodeById: new Map(staticNodes.map(item => [item.nodeId, item])),
  };
}

function nodeKind(index: StaticIndex, nodeId: string): NodeIR["kind"] | undefined {
  return index.nodeById.get(nodeId)?.kind;
}

function visitScope(scope: ScopeIR, nodes: RunStatusStaticNode[]): void {
  for (const node of scope.nodes) {
    nodes.push({
      nodeId: node.id,
      kind: node.kind,
      order: nodes.length,
      ...(node.kind === "signal" ? { outputSchema: node.outputSchema } : {}),
    });
    for (const child of childScopes(node)) visitScope(child, nodes);
  }
}

function childScopes(node: NodeIR): ScopeIR[] {
  if (node.kind === "if") return [node.then, node.else];
  if (node.kind === "switch") return [...node.cases.map(item => item.then), node.default];
  if (node.kind === "parallel") return Object.values(node.branches).map(branch => branch.scope);
  if (node.kind === "fanout" || node.kind === "loop") return [node.do];
  return [];
}
