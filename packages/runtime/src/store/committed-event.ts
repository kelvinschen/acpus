import type { JsonValue } from "@acpus/expression/ir";
import { decodeSchedulerPayload, isSchedulerEventType } from "../scheduler/event-codec.js";

export type CommittedRuntimeEventRow = {
  runId: string;
  sequence: number;
  type: string;
  nodeKey?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
};

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
  if (isSchedulerEventType(eventType)) return decodeSchedulerPayload(payloadJson, eventType);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}
