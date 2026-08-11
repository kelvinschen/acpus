import { resolve } from "node:path";
import type { AgentNodeIR, NodeIR, TaskNodeIR, WorkflowIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { readVerifiedArtifact } from "../artifacts/access.js";
import { indexNodes } from "../scheduler/ir-walk.js";
import { throwSchedulerStoreResult } from "../scheduler/store-port.js";
import type { SchedulerProjection } from "../scheduler/types.js";
import { isRuntimeStoreBusyError } from "../storage/database.js";
import type { CommittedRuntimeEventRow } from "../store/committed-event.js";
import type { RunExecutionMetadata } from "../store/inspection-read-model.js";
import type { FrozenRun, RuntimeStore } from "../store/store.js";
import type { HookEvent } from "./config.js";

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

export type HookDispatchRetry = {
  type: "hook-dispatch-retry";
  runId: string;
  stage: "read-cursor" | "read-events" | "load-projection" | "load-metadata" | "advance-cursor";
  message: string;
};

export type HookDispatchProgress = {
  runId: string;
  eventSequence: number;
  dispatched: number;
};

type HookDispatchTarget = {
  trigger(event: HookEvent, context: HookContext): void;
};

type HookDispatchInput = {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookDispatchTarget;
  frozen: FrozenRun;
};

export function dispatchCommittedHooksForRun(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookDispatchTarget;
}): Result<HookDispatchProgress, HookDispatchRetry> {
  const frozen = hookDispatchStage(input.runId, "load-projection", () => input.store.getFrozenRun(input.runId));
  if (frozen.isErr()) return err(frozen.error);
  if (!frozen.value) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  return dispatchCommittedHooks({ ...input, frozen: frozen.value });
}

export function dispatchHooksAtCheckpoint(input: HookDispatchInput & {
  shouldDispatchHooks?: (runId: string) => boolean;
  onHookIncident?: (runId: string, error: unknown) => void;
}): void {
  if (input.shouldDispatchHooks?.(input.runId) === false) return;
  try {
    dispatchCommittedHooks(input);
  } catch (error) {
    if (!input.onHookIncident) throw error;
    input.onHookIncident(input.runId, error);
  }
}

function dispatchCommittedHooks(input: HookDispatchInput): Result<HookDispatchProgress, HookDispatchRetry> {
  let dispatched = 0;
  for (;;) {
    const cursor = hookDispatchStage(input.runId, "read-cursor", () => input.store.getHookDispatchCursor(input.runId));
    if (cursor.isErr()) return err(cursor.error);
    const read = hookDispatchStage(input.runId, "read-events", () => input.store.readHookDispatchEvents(input.runId, cursor.value));
    if (read.isErr()) return err(read.error);
    if (cursor.value > read.value.lastSequence) {
      throw new Error(`Run '${input.runId}' hook dispatch cursor ${cursor.value} exceeds committed event sequence ${read.value.lastSequence}.`);
    }
    const row = read.value.events[0];
    if (!row) {
      if (cursor.value !== read.value.lastSequence) {
        throw new Error(`Run '${input.runId}' hook dispatch cursor ${cursor.value} has no next committed event before sequence ${read.value.lastSequence}.`);
      }
      return ok({ runId: input.runId, eventSequence: cursor.value, dispatched });
    }
    if (row.sequence !== cursor.value + 1) {
      throw new Error(`Run '${input.runId}' hook dispatch event sequence jumps from ${cursor.value} to ${row.sequence}.`);
    }

    const hookEvent = mapRuntimeEventToHookEvent(row);
    let prepared: { event: NonNullable<typeof hookEvent>; context: HookContext } | undefined;
    if (hookEvent && input.hookRunner) {
      const projection = hookDispatchStage(input.runId, "load-projection", () =>
        throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId)).projection);
      if (projection.isErr()) return err(projection.error);
      const context = hookDispatchStage(input.runId, "load-metadata", () => {
        const metadata = input.store.getExecutionMetadata(input.runId);
        const payload = objectValue(row.payload);
        const attemptId = typeof payload?.attemptId === "string" ? payload.attemptId : undefined;
        const agentPrompts = loadAgentPrompts(input.cwd, input.store, input.runId, metadata, attemptId);
        return buildHookContext({
          row,
          hookEvent,
          projection: projection.value,
          ir: input.frozen.ir,
          workspaceDir: input.frozen.meta.workspaceDir ?? input.cwd,
          workflowPath: resolve(input.cwd, input.frozen.meta.workflowPath ?? ""),
          executionMetadata: metadata,
          agentPrompts,
        });
      });
      if (context.isErr()) return err(context.error);
      prepared = { event: hookEvent, context: context.value };
    }

    const advanced = hookDispatchStage(input.runId, "advance-cursor", () =>
      input.store.compareAndSetHookDispatchCursor(input.runId, cursor.value, row.sequence));
    if (advanced.isErr()) return err(advanced.error);
    if (!advanced.value) continue;
    if (prepared) {
      try {
        input.hookRunner!.trigger(prepared.event, prepared.context);
      } catch {
        // Hook observers are terminal side effects; their failure never rolls back the durable cursor.
      }
      dispatched += 1;
    }
  }
}

function mapRuntimeEventToHookEvent(row: CommittedRuntimeEventRow): HookEvent | undefined {
  if (row.type === "frame.started" && row.payload.frameKey === "root" && row.payload.frameKind === "root") return "run.started";
  if (row.type === "run.completed") return "run.completed";
  if (row.type === "run.failed") return "run.failed";
  if (row.type === "run.canceled") return "run.canceled";
  if (row.type === "instance.completed") return "node.completed";
  if (row.type === "instance.failed") return "node.failed";
  if (row.type === "instance.started") return "node.started";
  if (row.type === "signal.awaiting") return "run.awaiting";
  return undefined;
}

function buildHookContext(input: {
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
  if (input.hookEvent === "run.canceled") {
    return { ...context, cancellation: { reason: stringField(input.row.payload, "reason") ?? "canceled" } };
  }
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

function buildNodeContext(
  input: Parameters<typeof buildHookContext>[0],
  nodeKey: string,
): NonNullable<HookContext["node"]> | undefined {
  const instance = input.projection.instances[nodeKey];
  const nodeId = instance?.nodeId ?? stringField(input.row.payload, "nodeId");
  if (!nodeId) return undefined;
  const node = indexNodes(input.ir.root).get(nodeId);
  if (!node || !isHookNode(node)) return undefined;
  const base = {
    id: node.id,
    key: nodeKey,
    kind: node.kind,
    status: nodeStatusForEvent(input.hookEvent)
      ?? instance?.status
      ?? input.projection.signalWaits[nodeKey]?.status
      ?? "unknown",
  };
  const attemptId = stringField(input.row.payload, "attemptId")
    ?? stringField(input.row.payload, "acceptedAttemptId");
  const metadata = attemptMetadata(input.executionMetadata, nodeKey, `${node.kind}_attempt`, attemptId);
  if (node.kind === "agent") {
    const agentPrompt = attemptId === undefined ? undefined : input.agentPrompts?.get(attemptId);
    return {
      ...base,
      ...(agentPrompt === undefined ? {} : { agentPrompt }),
      ...nodeResultFields(input.hookEvent, input.row.payload),
    };
  }
  if (node.kind === "task") {
    return {
      ...base,
      ...(metadata.input === undefined ? {} : { taskInput: metadata.input }),
      ...nodeResultFields(input.hookEvent, input.row.payload),
    };
  }
  return { ...base, ...nodeResultFields(input.hookEvent, input.row.payload) };
}

function attemptMetadata(
  rows: RunExecutionMetadata[],
  nodeKey: string,
  kind: string,
  attemptId: string | undefined,
): Record<string, unknown> {
  if (attemptId === undefined) return {};
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const metadata = recordValue(row.metadata);
    if (row.kind === kind && metadata.nodeKey === nodeKey && row.attemptId === attemptId) return metadata;
  }
  return {};
}

function nodeResultFields(
  hookEvent: HookEvent,
  payload: Record<string, unknown>,
): Pick<NonNullable<HookContext["node"]>, "output" | "error"> {
  return {
    ...(hookEvent === "node.completed" && payload.output !== undefined ? { output: payload.output } : {}),
    ...(hookEvent === "node.failed" && payload.error !== undefined ? { error: errorFrom(payload.error) } : {}),
  };
}

function loadAgentPrompts(
  cwd: string,
  store: RuntimeStore,
  runId: string,
  rows: ReturnType<RuntimeStore["getExecutionMetadata"]>,
  attemptId: string | undefined,
): Map<string, string> {
  const prompts = new Map<string, string>();
  if (!attemptId) return prompts;
  for (const row of rows) {
    if (row.kind !== "agent_attempt" || row.attemptId !== attemptId) continue;
    const metadata = objectValue(row.metadata);
    const firstTurn = Array.isArray(metadata?.turns) ? objectValue(metadata.turns[0]) : undefined;
    const turnArtifact = objectValue(firstTurn?.turnArtifact);
    const artifactId = typeof turnArtifact?.artifactId === "string" ? turnArtifact.artifactId : undefined;
    if (!artifactId) continue;
    const read = readVerifiedArtifact({ cwd, runId, store }, artifactId);
    if (!read) throw new Error(`Agent turn artifact '${artifactId}' is not registered for run '${runId}'.`);
    const artifact = objectValue(JSON.parse(read.bytes.toString("utf8")));
    if (!artifact || typeof artifact.prompt !== "string") {
      throw new Error(`Agent turn artifact '${artifactId}' has an invalid prompt.`);
    }
    prompts.set(attemptId, artifact.prompt);
    break;
  }
  return prompts;
}

function hookDispatchStage<T>(
  runId: string,
  stage: HookDispatchRetry["stage"],
  read: () => T,
): Result<T, HookDispatchRetry> {
  try {
    return ok(read());
  } catch (error) {
    if (isRuntimeStoreBusyError(error)) {
      return err({
        type: "hook-dispatch-retry",
        runId,
        stage,
        message: "Runtime store is busy. Retry hook dispatch on a later daemon tick.",
      });
    }
    throw error;
  }
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
    const record = value as { message?: unknown; reason?: unknown };
    const message = record.message ?? record.reason;
    if (typeof message === "string") return { message };
  }
  return { message: value === undefined ? "failed" : String(value) };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return objectValue(value) ?? {};
}

function isHookNode(node: NodeIR): node is AgentNodeIR | TaskNodeIR | Extract<NodeIR, { kind: "signal" }> {
  return node.kind === "agent" || node.kind === "task" || node.kind === "signal";
}
