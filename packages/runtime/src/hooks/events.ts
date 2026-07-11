import type { JsonValue } from "@acpus/expression/ir";
import { decodeSchedulerPayload, isSchedulerEventType } from "../scheduler/event-codec.js";
import type { HookEvent } from "./config.js";

export type CommittedRuntimeEventRow = {
  runId: string;
  sequence: number;
  type: string;
  nodeKey?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
};

export function mapRuntimeEventToHookEvent(row: CommittedRuntimeEventRow): HookEvent | undefined {
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

export function decodeCommittedRuntimeEventRow(row: {
  run_id: string;
  sequence: number;
  type: string;
  node_key: string | null;
  payload_json: string;
  created_at: string;
  idempotency_key: string;
}): CommittedRuntimeEventRow {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    ...(row.node_key === null ? {} : { nodeKey: row.node_key }),
    payload: decodeRuntimeEventPayload(row.payload_json, row.type),
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
  };
}

function decodeRuntimeEventPayload(payloadJson: string, eventType: string): Record<string, unknown> {
  const parsed = JSON.parse(payloadJson) as JsonValue;
  if (isSchedulerEventType(eventType)) {
    return decodeSchedulerPayload(payloadJson, eventType);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}
