import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { normalizeValue } from "../evaluation/schema.js";

export function normalizeWorkflowInput(ir: WorkflowIR, input: JsonValue, label = "Workflow input"): JsonValue {
  return normalizeValue(ir.inputSchema, input, label);
}

export function normalizeSignalPayload(ir: WorkflowIR, nodeId: string, payload: JsonValue): JsonValue {
  for (const { node } of walkNodes(ir.root)) {
    if (node.id !== nodeId || node.kind !== "signal") continue;
    if (!node.outputSchema) {
      if (typeof payload !== "string") throw new Error("Signal payload expected string.");
      return payload;
    }
    return normalizeValue(node.outputSchema, payload, "Signal payload");
  }
  throw new Error(`Signal node '${nodeId}' was not found.`);
}
