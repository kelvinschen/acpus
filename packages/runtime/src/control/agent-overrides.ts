import { z } from "@acpus/core/schema";
import { err, ok, type Result } from "neverthrow";
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
  return tryParseAgentOverrideMap(value, irAgents).match(
    parsed => parsed,
    failure => {
      throw new Error(failure.message);
    },
  );
}

export type AgentOverrideParseFailure = {
  type: "agent-overrides-invalid";
  reason: "not-object" | "unknown-agent" | "schema";
  message: string;
  agentName?: string;
  path?: string;
};

export function tryParseAgentOverrideMap(value: unknown, irAgents?: Record<string, unknown>): Result<AgentOverrideMap, AgentOverrideParseFailure> {
  if (!isPlainRecord(value)) return err({ type: "agent-overrides-invalid", reason: "not-object", message: "Agent overrides must be a JSON object keyed by declared agent name." });
  if (irAgents) {
    const unknownAgent = Object.keys(value).find(name => !irAgents[name]);
    if (unknownAgent) return err({
      type: "agent-overrides-invalid",
      reason: "unknown-agent",
      agentName: unknownAgent,
      message: `Agent override '${unknownAgent}' does not reference a declared agent.`,
    });
  }
  const parsed = AgentOverrideMapSchema.safeParse(value);
  if (parsed.success) return ok(parsed.data as AgentOverrideMap);
  const firstPath = parsed.error.issues[0]?.path;
  const path = firstPath === undefined ? undefined : firstPath.length === 0 ? "$" : `$.${firstPath.join(".")}`;
  return err({
    type: "agent-overrides-invalid",
    reason: "schema",
    ...(path === undefined ? {} : { path }),
    message: `Agent overrides is invalid: ${parsed.error.issues.map(formatIssue).join("; ")}`,
  });
}

export function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  return `${path} ${issue.message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
