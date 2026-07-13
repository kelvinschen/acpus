import type { AgentNodeIR, NodeIR, TaskNodeIR, WorkflowIR } from "@acpus/core/ir";
import { indexNodes } from "../scheduler/ir-walk.js";
import type { SchedulerProjection } from "../scheduler/types.js";
import type { RunExecutionMetadata } from "../store/store.js";
import type { HookEvent } from "./config.js";
import type { CommittedRuntimeEventRow } from "./events.js";

export type HookContext = {
  event: HookEvent;
  eventSequence: number;
  run: {
    id: string;
    workflowName: string;
    workflowPath: string;
    workspaceDir: string;
    status: string;
  };
  node?: {
    id: string;
    key: string;
    kind: "task" | "agent" | "signal";
    status: string;
    output?: unknown;
    error?: { message: string };
    agentPrompt?: string;
    taskInput?: unknown;
  };
  output?: unknown;
  error?: { message: string };
  cancellation?: { reason: string };
  signal?: {
    nodeId: string;
    nodeKey: string;
    prompt: string;
  };
};

export function buildHookContext(input: {
  row: CommittedRuntimeEventRow;
  hookEvent: HookEvent;
  projection: SchedulerProjection;
  ir: WorkflowIR;
  workspaceDir: string;
  workflowPath: string;
  executionMetadata: RunExecutionMetadata[];
  agentPrompts?: ReadonlyMap<string, string>;
}): HookContext {
  const context: HookContext = {
    event: input.hookEvent,
    eventSequence: input.row.sequence,
    run: {
      id: input.row.runId,
      workflowName: input.ir.name,
      workflowPath: input.workflowPath,
      workspaceDir: input.workspaceDir,
      status: runStatusForEvent(input.hookEvent),
    },
  };

  if (input.hookEvent === "run.completed") return { ...context, output: input.row.payload.output };
  if (input.hookEvent === "run.failed") return { ...context, error: errorFrom(input.row.payload) };
  if (input.hookEvent === "run.canceled") return { ...context, cancellation: { reason: stringField(input.row.payload, "reason") ?? "canceled" } };
  if (input.hookEvent === "run.awaiting") {
    const nodeKey = stringField(input.row.payload, "nodeKey") ?? input.row.nodeKey ?? "";
    const wait = input.projection.signalWaits[nodeKey];
    const nodeId = stringField(input.row.payload, "nodeId") ?? wait?.nodeId ?? "";
    const prompt = stringField(input.row.payload, "renderedPrompt") ?? wait?.renderedPrompt;
    const nodeContext = buildNodeContext(input, nodeKey);
    return {
      ...context,
      ...(nodeContext === undefined ? {} : { node: nodeContext }),
      ...(prompt === undefined ? {} : { signal: { nodeId, nodeKey, prompt } }),
    };
  }

  if (input.hookEvent.startsWith("node.")) {
    const nodeKey = stringField(input.row.payload, "nodeKey") ?? input.row.nodeKey;
    const nodeContext = nodeKey ? buildNodeContext(input, nodeKey) : undefined;
    return nodeContext ? { ...context, node: nodeContext } : context;
  }

  return context;
}

function buildNodeContext(input: Parameters<typeof buildHookContext>[0], nodeKey: string): NonNullable<HookContext["node"]> | undefined {
  const instance = input.projection.instances[nodeKey];
  const nodeId = instance?.nodeId ?? stringField(input.row.payload, "nodeId");
  if (!nodeId) return undefined;
  const node = indexNodes(input.ir.root).get(nodeId);
  if (!node || !isHookNode(node)) return undefined;
  const base = {
    id: node.id,
    key: nodeKey,
    kind: node.kind,
    status: nodeStatusForEvent(input.hookEvent) ?? instance?.status ?? input.projection.signalWaits[nodeKey]?.status ?? "unknown",
  };
  const metadata = latestAttemptMetadata(input.executionMetadata, nodeKey, `${node.kind}_attempt`);
  if (node.kind === "agent") {
    const agentPrompt = input.agentPrompts?.get(nodeKey);
    return { ...base, ...(agentPrompt === undefined ? {} : { agentPrompt }), ...nodeResultFields(input.hookEvent, input.row.payload) };
  }
  if (node.kind === "task") {
    const taskInput = metadata.input;
    return { ...base, ...(taskInput === undefined ? {} : { taskInput }), ...nodeResultFields(input.hookEvent, input.row.payload) };
  }
  return { ...base, ...nodeResultFields(input.hookEvent, input.row.payload) };
}

function latestAttemptMetadata(rows: RunExecutionMetadata[], nodeKey: string, kind: string): Record<string, unknown> {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const metadata = recordValue(row.metadata);
    if (row.kind === kind && metadata.nodeKey === nodeKey) return metadata;
  }
  return {};
}

function nodeResultFields(hookEvent: HookEvent, payload: Record<string, unknown>): Pick<NonNullable<HookContext["node"]>, "output" | "error"> {
  return {
    ...(hookEvent === "node.completed" && payload.output !== undefined ? { output: payload.output } : {}),
    ...(hookEvent === "node.failed" && payload.error !== undefined ? { error: errorFrom(payload.error) } : {}),
  };
}

function runStatusForEvent(hookEvent: HookEvent): string {
  if (hookEvent === "run.started") return "running";
  if (hookEvent === "run.awaiting") return "awaiting";
  if (hookEvent === "run.completed") return "completed";
  if (hookEvent === "run.failed") return "failed";
  if (hookEvent === "run.canceled") return "canceled";
  return "running";
}

function nodeStatusForEvent(hookEvent: HookEvent): string | undefined {
  if (hookEvent === "node.started") return "running";
  if (hookEvent === "node.completed") return "completed";
  if (hookEvent === "node.failed") return "failed";
  if (hookEvent === "run.awaiting") return "awaiting";
  return undefined;
}

function errorFrom(value: unknown): { message: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as { message?: unknown; reason?: unknown }).message ?? (value as { reason?: unknown }).reason;
    if (typeof message === "string") return { message };
  }
  return { message: value === undefined ? "failed" : String(value) };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isHookNode(node: NodeIR): node is AgentNodeIR | TaskNodeIR | Extract<NodeIR, { kind: "signal" }> {
  return node.kind === "agent" || node.kind === "task" || node.kind === "signal";
}
