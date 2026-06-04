import { DEFAULT_AGENT_OUTPUT_SCHEMA, formatSchema, type CompiledSchema } from "../contracts/schema-dsl.js";
import { RuntimeErrorCodes, type AgentTaskRetryReason } from "../run-index/read-write.js";
import type { OutputParseFailure } from "./output-parser.js";

export const AGENT_TASK_RETRY_BUDGET = 2;
export const AGENT_TASK_RETRY_DELAY_MS = 5_000;

let agentTaskRetryDelayOverrideMs: number | undefined;

export function agentTaskRetryDelayMs(): number {
  return agentTaskRetryDelayOverrideMs ?? AGENT_TASK_RETRY_DELAY_MS;
}

export function setAgentTaskRetryDelayForTests(delayMs: number | undefined): void {
  agentTaskRetryDelayOverrideMs = delayMs;
}

export function retryableOutputFailure(reason: string | undefined): boolean {
  return reason === "OUTPUT_PARSE_FAILED" || reason === "OUTPUT_SCHEMA_FAILED";
}

export function formatContinuationPrompt(input: {
  failure: OutputParseFailure;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
}): string {
  return [
    "**Continue your work. The previous turn did not produce a valid workflow output; previous failure code: "
      + `${input.failure.errorCode}. After completing the whole task, respond with exactly one valid, parseable final JSON object without `
      + "```json fence that satisfies this schema; the response must start with `{` and end with `}` and include no prose, Markdown, or code fences.**",
    "",
    "# Final Output Contract",
    "",
    "```typescript",
    formatSchemaForRetry(input.outputSchema, input.implicitOutputFields),
    "```"
  ].join("\n");
}

export function retryExhaustedEnvelope(input: {
  summary: string;
  lastFailureCode: string;
  retryHistory: unknown[];
}): Record<string, unknown> {
  return {
    status: "blocked",
    summary: input.summary,
    blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
    lastFailureCode: input.lastFailureCode,
    retryHistory: input.retryHistory,
    metadata: {
      retryExhausted: true,
      retryBudgetLimit: AGENT_TASK_RETRY_BUDGET
    }
  };
}

export function retryCountByReason(attempts: Array<{ retryReason?: AgentTaskRetryReason }>): Record<AgentTaskRetryReason, number> {
  return {
    runtime: attempts.filter((attempt) => attempt.retryReason === "runtime").length,
    stale: attempts.filter((attempt) => attempt.retryReason === "stale").length,
    continuation: attempts.filter((attempt) => attempt.retryReason === "continuation").length
  };
}

function formatSchemaForRetry(schema: CompiledSchema | undefined, implicit: string[] | undefined): string {
  const ast = schema?.ast ?? DEFAULT_AGENT_OUTPUT_SCHEMA.ast;
  if (!implicit || implicit.length === 0 || ast.kind !== "object") return formatSchema(ast);
  const implicitFields = implicit.map((name) => implicitField(name));
  return formatSchema({
    kind: "object",
    fields: [
      ...ast.fields.filter((field) => !implicitFields.some((implicitField) => implicitField.name === field.name)),
      ...implicitFields
    ]
  });
}

function implicitField(name: string) {
  if (name.startsWith("route:")) {
    return { name: "route", optional: false as const, schema: routeFieldSchema(name) };
  }
  return { name, optional: false as const, schema: implicitFieldSchema(name) };
}

function implicitFieldSchema(name: string) {
  if (name === "verdict") {
    return {
      kind: "union" as const,
      options: [
        { kind: "literal" as const, value: "pass" },
        { kind: "literal" as const, value: "pass_with_warnings" },
        { kind: "literal" as const, value: "blocked" },
        { kind: "literal" as const, value: "failed" },
        { kind: "literal" as const, value: "unknown" }
      ]
    };
  }
  if (name.startsWith("route:")) return routeFieldSchema(name);
  return { kind: "primitive" as const, name: "string" as const };
}

function routeFieldSchema(name: string) {
  const routes = name.slice("route:".length).split("|").filter(Boolean);
  if (routes.length === 0) return { kind: "primitive" as const, name: "string" as const };
  return {
    kind: "union" as const,
    options: routes.map((route) => ({ kind: "literal" as const, value: route }))
  };
}
