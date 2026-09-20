import type { CallToolResult } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";

export type ToolFailure = {
  code: string;
  message: string;
  next: string;
  phase?: string;
  diagnostics?: unknown;
  candidates?: unknown;
  runId?: string;
  workspace?: string;
  outcome?: string;
};

export function toolFailure(
  failure: { type: string; message: string; code?: string },
  next: string,
): ToolFailure {
  return {
    code: failure.code ?? failure.type.replaceAll("-", "_").toUpperCase(),
    message: failure.message,
    next,
    ...("phase" in failure && typeof failure.phase === "string" ? { phase: failure.phase } : {}),
    ...("diagnostics" in failure ? { diagnostics: failure.diagnostics } : {}),
    ...("candidates" in failure ? { candidates: failure.candidates } : {}),
  };
}

export function toolResult(
  operation: Effect.Effect<Record<string, unknown>, ToolFailure>,
): Effect.Effect<CallToolResult> {
  return Effect.match(operation, {
    onSuccess: value => result(value, false),
    onFailure: error => result({ error }, true),
  });
}

function result(value: Record<string, unknown>, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}
