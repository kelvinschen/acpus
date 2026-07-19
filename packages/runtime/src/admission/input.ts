import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";
import { tryNormalizeValue, type SchemaNormalizationFailure } from "../evaluation/schema.js";

export type { SchemaNormalizationFailure };

export function tryNormalizeWorkflowInput(ir: WorkflowIR, input: JsonValue, label = "Workflow input"): Result<JsonValue, SchemaNormalizationFailure> {
  return tryNormalizeValue(ir.inputSchema, input, label);
}

export type SignalPayloadNormalizationFailure =
  | SchemaNormalizationFailure
  | { type: "signal-payload-invalid"; nodeId: string; message: string }
  | { type: "signal-node-not-found"; nodeId: string; message: string };

export function tryNormalizeSignalPayload(ir: WorkflowIR, nodeId: string, payload: JsonValue): Result<JsonValue, SignalPayloadNormalizationFailure> {
  for (const { node } of walkNodes(ir.root)) {
    if (node.id !== nodeId || node.kind !== "signal") continue;
    if (!node.outputSchema) {
      if (typeof payload !== "string") return err({ type: "signal-payload-invalid", nodeId, message: "Signal payload expected string." });
      return ok(payload);
    }
    return tryNormalizeValue(node.outputSchema, payload, "Signal payload");
  }
  return err({ type: "signal-node-not-found", nodeId, message: `Signal node '${nodeId}' was not found.` });
}
