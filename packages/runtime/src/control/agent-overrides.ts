import { z, type Schema } from "@acpus/core/schema";
import type { AgentOverrideMap } from "../store/store.js";

const AgentOverrideSchema = z.object({
  use: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]).optional(),
  agentMode: z.string().min(1).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict().refine(value => value.use === undefined || value.command === undefined, {
  message: "must not specify both use and command",
});

const AgentOverrideMapSchema = z.record(z.string(), AgentOverrideSchema);

export function parseAgentOverrideMap(value: unknown, irAgents?: Record<string, unknown>): AgentOverrideMap {
  if (!isPlainRecord(value)) throw new Error("Agent overrides must be a JSON object keyed by declared agent name.");
  if (irAgents) {
    const unknownAgent = Object.keys(value).find(name => !irAgents[name]);
    if (unknownAgent) throw new Error(`Agent override '${unknownAgent}' does not reference a declared agent.`);
  }
  return parseSchema("Agent overrides", AgentOverrideMapSchema, value) as AgentOverrideMap;
}

export function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function parseSchema<T>(label: string, schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`${label} is invalid: ${result.error.issues.map(formatIssue).join("; ")}`);
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  return `${path} ${issue.message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
