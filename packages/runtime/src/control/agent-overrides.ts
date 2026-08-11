import { z } from "@acpus/core/schema";
import type { AgentDefinitionIR, WorkflowIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";

const AgentOverrideSchema = z.object({
  use: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]).optional(),
  config: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict().refine(value => value.use === undefined || value.command === undefined, {
  message: "must not specify both use and command",
});

type AgentOverrideSpec = z.infer<typeof AgentOverrideSchema>;
export type AgentOverrideMap = Record<string, AgentOverrideSpec>;

const AgentOverrideMapSchema = z.record(z.string(), AgentOverrideSchema);

export function parseAgentOverrideMap(value: unknown, irAgents?: Record<string, unknown>): AgentOverrideMap {
  return tryParseAgentOverrideMap(value, irAgents).match(
    parsed => parsed,
    failure => {
      throw new Error(failure.message);
    },
  );
}

export type AgentOverrideValidationFailure = {
  type: "agent-overrides-invalid";
  reason: "not-object" | "unknown-agent" | "schema";
  message: string;
  agentName?: string;
  path?: string;
};

export function tryParseAgentOverrideMap(value: unknown, irAgents?: Record<string, unknown>): Result<AgentOverrideMap, AgentOverrideValidationFailure> {
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

export function tryValidateAgentOverrides(
  ir: WorkflowIR,
  input: AgentOverrideMap | undefined,
): Result<AgentOverrideMap, AgentOverrideValidationFailure> {
  if (input === undefined) return ok({});
  return tryParseAgentOverrideMap(input, ir.agents).map(parsed => normalizeAgentOverrides(ir, parsed));
}

export function normalizeAgentOverrides(
  ir: WorkflowIR,
  input: AgentOverrideMap | undefined,
  inherited: AgentOverrideMap = {},
): AgentOverrideMap {
  const base = Object.fromEntries(Object.entries(inherited).filter(([name]) => ir.agents[name])) as AgentOverrideMap;
  if (input === undefined) return base;
  const incoming = parseAgentOverrideMap(input, ir.agents);
  const merged = Object.fromEntries(Object.entries(incoming).map(([name, override]) => {
    const previous = base[name] ?? {};
    const declared = ir.agents[name]!;
    return [name, mergeAgentOverride(declared, previous, override)];
  }));
  return { ...base, ...merged };
}

export function withAgentOverrides(ir: WorkflowIR, overrides: AgentOverrideMap): WorkflowIR {
  if (Object.keys(overrides).length === 0) return ir;
  return {
    ...ir,
    agents: Object.fromEntries(Object.entries(ir.agents).map(([name, definition]) => [
      name,
      applyAgentOverride(definition, overrides[name]),
    ])),
  };
}

function mergeAgentOverride(
  declared: AgentDefinitionIR,
  previous: AgentOverrideSpec,
  incoming: AgentOverrideSpec,
): AgentOverrideSpec {
  const before = agentIdentity(declared, previous);
  const after = agentIdentity(declared, { ...previous, ...incoming });
  const changedIdentity = incoming.use !== undefined || incoming.command !== undefined
    ? before.kind !== after.kind || before.value !== after.value
    : false;
  const merged = changedIdentity
    ? { ...previous, model: undefined, config: undefined, ...incoming }
    : { ...previous, ...incoming };
  if (incoming.use !== undefined) delete merged.command;
  if (incoming.command !== undefined) delete merged.use;
  return compactUndefined(merged) as AgentOverrideSpec;
}

function applyAgentOverride(definition: AgentDefinitionIR, override: AgentOverrideSpec | undefined): AgentDefinitionIR {
  if (!override) return definition;
  const identityChanged = override.use !== undefined || override.command !== undefined
    ? agentIdentity(definition, {}).kind !== agentIdentity(definition, override).kind
      || agentIdentity(definition, {}).value !== agentIdentity(definition, override).value
    : false;
  const shared = {
    model: override.model ?? (identityChanged ? undefined : definition.model),
    permissionMode: override.permissionMode ?? definition.permissionMode,
    config: override.config ?? (identityChanged ? undefined : definition.config),
    cwd: override.cwd ?? definition.cwd,
    env: override.env ?? definition.env,
  };
  if (override.command !== undefined) {
    return compactUndefined({ kind: "agent_command", command: override.command, ...shared }) as AgentDefinitionIR;
  }
  if (override.use !== undefined) {
    return compactUndefined({ kind: "agent_definition", use: override.use, ...shared }) as AgentDefinitionIR;
  }
  return compactUndefined({ ...definition, ...shared }) as AgentDefinitionIR;
}

function agentIdentity(
  definition: AgentDefinitionIR,
  override: AgentOverrideSpec,
): { kind: "use" | "command"; value: string } {
  if (override.command !== undefined) return { kind: "command", value: override.command };
  if (override.use !== undefined) return { kind: "use", value: override.use };
  return definition.kind === "agent_command"
    ? { kind: "command", value: definition.command }
    : { kind: "use", value: definition.use };
}

function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  return `${path} ${issue.message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
