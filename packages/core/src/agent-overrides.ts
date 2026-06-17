import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentSpec, WorkflowSpec } from "./types.js";

export type AgentOverrides = Record<string, AgentOverride>;

export interface AgentOverride {
  type?: "builtin" | "command";
  use?: string;
  model?: string;
  cwd?: string;
  env?: Record<string, unknown>;
  policy?: "read" | "full";
}

export interface AgentOverrideWarning {
  code: "AGENT_MODEL_CLEARED" | "INHERITED_AGENT_OVERRIDE_SKIPPED";
  agent: string;
  message: string;
}

export interface ApplyAgentOverridesOptions {
  inherited?: AgentOverrides;
}

export interface ApplyAgentOverridesResult {
  effectiveSpec: WorkflowSpec;
  agentOverrides: AgentOverrides;
  warnings: AgentOverrideWarning[];
}

const SUPPORTED_OVERRIDE_FIELDS = new Set(["type", "use", "model", "cwd", "env", "policy"]);
const SUPPORTED_FILE_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

export function parseAgentOverridesInput(value: string | undefined, cwd = process.cwd()): AgentOverrides | undefined {
  if (value === undefined) return undefined;

  const possiblePath = resolve(cwd, value);
  if (existsSync(possiblePath)) {
    const stat = statSync(possiblePath);
    if (stat.isDirectory()) {
      throw new Error("--agents must be a JSON/YAML file or inline JSON/YAML object, not a directory.");
    }
    const extension = extname(possiblePath).toLowerCase();
    if (!SUPPORTED_FILE_EXTENSIONS.has(extension)) {
      throw new Error("--agents file must use .json, .yaml, or .yml.");
    }
    const contents = readFileSync(possiblePath, "utf8");
    const parsed = extension === ".json" ? JSON.parse(contents) : parseYaml(contents);
    return validateAgentOverrides(parsed, "--agents");
  }

  if (looksLikePath(value)) {
    throw new Error(`--agents file not found: ${value}`);
  }

  return validateAgentOverrides(parseYaml(value), "--agents");
}

export function parseWorkflowSpecForOverrides(source: string): WorkflowSpec {
  const parsed = parseYaml(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Workflow spec must be a YAML object.");
  }
  return parsed as WorkflowSpec;
}

export function serializeWorkflowSpecForOverrides(spec: WorkflowSpec): string {
  return JSON.stringify(spec);
}

export function emptyAgentOverrideResult(spec?: WorkflowSpec): ApplyAgentOverridesResult {
  return {
    effectiveSpec: spec ?? { version: 1, name: "", workflow: { steps: [] } },
    agentOverrides: {},
    warnings: []
  };
}

export function optionalSubmissionMetadata(result: ApplyAgentOverridesResult): {
  agentOverrides?: AgentOverrides;
  submissionWarnings?: AgentOverrideWarning[];
} {
  return {
    agentOverrides: Object.keys(result.agentOverrides).length > 0 ? result.agentOverrides : undefined,
    submissionWarnings: result.warnings.length > 0 ? result.warnings : undefined
  };
}

export function validateAgentOverrides(value: unknown, label = "Agent Overrides"): AgentOverrides {
  if (!isRecord(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }
  const overrides: AgentOverrides = {};
  for (const [agentName, rawOverride] of Object.entries(value)) {
    if (!isRecord(rawOverride)) {
      throw new Error(`${label}.${agentName} must be an object.`);
    }
    const keys = Object.keys(rawOverride);
    if (keys.length === 0) {
      throw new Error(`${label}.${agentName} must not be empty.`);
    }
    for (const key of keys) {
      if (!SUPPORTED_OVERRIDE_FIELDS.has(key)) {
        throw new Error(`${label}.${agentName}.${key} is not supported.`);
      }
    }
    if ((rawOverride.type === undefined) !== (rawOverride.use === undefined)) {
      throw new Error(`${label}.${agentName} must specify type and use together.`);
    }
    if (rawOverride.type !== undefined && rawOverride.type !== "builtin" && rawOverride.type !== "command") {
      throw new Error(`${label}.${agentName}.type must be 'builtin' or 'command'.`);
    }
    if (rawOverride.use !== undefined && typeof rawOverride.use !== "string") {
      throw new Error(`${label}.${agentName}.use must be a string.`);
    }
    if (rawOverride.model === null) {
      throw new Error(`${label}.${agentName}.model must be a string; null model clearing is not supported.`);
    }
    if (rawOverride.model !== undefined && typeof rawOverride.model !== "string") {
      throw new Error(`${label}.${agentName}.model must be a string.`);
    }
    if ("cwd" in rawOverride) {
      if (typeof rawOverride.cwd !== "string" || rawOverride.cwd.length === 0) {
        throw new Error(`${label}.${agentName}.cwd must be a non-empty string.`);
      }
    }
    if (rawOverride.env !== undefined && !isRecord(rawOverride.env)) {
      throw new Error(`${label}.${agentName}.env must be an object.`);
    }
    if (rawOverride.policy !== undefined && rawOverride.policy !== "read" && rawOverride.policy !== "full") {
      throw new Error(`${label}.${agentName}.policy must be 'read' or 'full'.`);
    }

    const override: AgentOverride = {};
    if (rawOverride.type !== undefined) override.type = rawOverride.type;
    if (rawOverride.use !== undefined) override.use = rawOverride.use;
    if (rawOverride.model !== undefined) override.model = rawOverride.model;
    if ("cwd" in rawOverride) override.cwd = rawOverride.cwd as string;
    if (rawOverride.env !== undefined) override.env = { ...rawOverride.env };
    if (rawOverride.policy !== undefined) override.policy = rawOverride.policy;
    overrides[agentName] = override;
  }
  return overrides;
}

export function applyAgentOverrides(
  spec: WorkflowSpec,
  current: AgentOverrides | undefined,
  options: ApplyAgentOverridesOptions = {}
): ApplyAgentOverridesResult {
  const agents = isRecord(spec.agents) ? spec.agents : {};
  const effectiveSpec: WorkflowSpec = {
    ...spec,
    agents: cloneAgents(agents)
  };
  const finalOverrides: AgentOverrides = {};
  const warnings: AgentOverrideWarning[] = [];

  for (const [agentName, inheritedOverride] of Object.entries(options.inherited ?? {})) {
    const normalized = validateSingleOverride(agentName, inheritedOverride, "inherited Agent Overrides");
    if (!Object.prototype.hasOwnProperty.call(agents, agentName)) {
      warnings.push({
        code: "INHERITED_AGENT_OVERRIDE_SKIPPED",
        agent: agentName,
        message: `Inherited Agent Override for '${agentName}' was skipped because the repaired Workflow Spec does not declare that agent.`
      });
      continue;
    }
    applySingleOverride(effectiveSpec.agents!, finalOverrides, agentName, normalized, warnings);
  }

  for (const [agentName, currentOverride] of Object.entries(current ?? {})) {
    const normalized = validateSingleOverride(agentName, currentOverride, "Agent Overrides");
    if (!Object.prototype.hasOwnProperty.call(agents, agentName)) {
      throw new Error(`Agent Override '${agentName}' does not match a top-level agent declared by the Workflow Spec.`);
    }
    applySingleOverride(effectiveSpec.agents!, finalOverrides, agentName, normalized, warnings);
  }

  return {
    effectiveSpec,
    agentOverrides: finalOverrides,
    warnings
  };
}

function validateSingleOverride(agentName: string, value: unknown, label: string): AgentOverride {
  return validateAgentOverrides({ [agentName]: value }, label)[agentName]!;
}

function applySingleOverride(
  agents: Record<string, AgentSpec>,
  finalOverrides: AgentOverrides,
  agentName: string,
  override: AgentOverride,
  warnings: AgentOverrideWarning[]
): void {
  const currentAgent = agents[agentName] ?? {};
  const currentOverride = finalOverrides[agentName] ?? {};
  const identityChanged = override.type !== undefined || override.use !== undefined;
  const mergedAgent: AgentSpec = { ...currentAgent };
  const mergedOverride: AgentOverride = { ...currentOverride };

  if (identityChanged) {
    mergedAgent.type = override.type;
    mergedAgent.use = override.use;
    mergedOverride.type = override.type;
    mergedOverride.use = override.use;
    // Model is identity-tied (different adapters use different models), so
    // clearing it on identity change prevents sending a stale model to a new
    // adapter. Policy is orthogonal to agent identity — a read-only reviewer
    // should stay read-only regardless of which adapter backs it — so policy
    // is preserved rather than cleared.
    if (override.model === undefined && mergedAgent.model !== undefined) {
      delete mergedAgent.model;
      delete mergedOverride.model;
      warnings.push({
        code: "AGENT_MODEL_CLEARED",
        agent: agentName,
        message: `Agent Override for '${agentName}' changed type/use and cleared the inherited model.`
      });
    }
  }
  if (override.model !== undefined) {
    mergedAgent.model = override.model;
    mergedOverride.model = override.model;
  }
  if ("cwd" in override) {
    mergedAgent.cwd = override.cwd;
    mergedOverride.cwd = override.cwd;
  }
  if (override.env !== undefined) {
    mergedAgent.env = { ...(isRecord(mergedAgent.env) ? mergedAgent.env : {}), ...override.env };
    mergedOverride.env = { ...(isRecord(mergedOverride.env) ? mergedOverride.env : {}), ...override.env };
  }
  if (override.policy !== undefined) {
    mergedAgent.policy = override.policy;
    mergedOverride.policy = override.policy;
  }

  agents[agentName] = mergedAgent;
  finalOverrides[agentName] = mergedOverride;
}

function cloneAgents(agents: Record<string, AgentSpec>): Record<string, AgentSpec> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      {
        ...agent,
        env: isRecord(agent.env) ? { ...agent.env } : agent.env
      }
    ])
  );
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.includes("\n") || /^[A-Za-z0-9_.-]+\s*:/.test(trimmed)) {
    return false;
  }
  return trimmed.startsWith(".")
    || trimmed.startsWith("/")
    || trimmed.startsWith("~")
    || trimmed.includes("/")
    || SUPPORTED_FILE_EXTENSIONS.has(extname(trimmed).toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
