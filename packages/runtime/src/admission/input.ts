import type { JsonValue, WorkflowIR } from "@acpus/core/ir";
import { findSignalNode } from "../execution/ir.js";
import { normalizeValue } from "../evaluation/schema.js";

export function normalizeWorkflowInput(ir: WorkflowIR, input: JsonValue, label = "Workflow input"): JsonValue {
  return normalizeValue(ir.inputSchema, input, label);
}

export function normalizeSignalPayload(ir: WorkflowIR, nodeId: string, payload: JsonValue): JsonValue {
  const signal = findSignalNode(ir.root, nodeId);
  if (!signal) throw new Error(`Signal node '${nodeId}' was not found.`);
  return normalizeValue(signal.outputSchema, payload, "Signal payload");
}
