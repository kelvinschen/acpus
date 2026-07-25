import { envToIR, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import { AGENT_TOKEN } from "../../internal/symbols.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { Resolvable } from "@acpus/expression";
import type { AgentDefinitionIR, AgentNodeIR, AgentRunIR, DiagnosticIR } from "../../ir/types.js";
import type { EnvInput, StaticEnvInput } from "./shared.js";

/** Permission modes accepted by Acpus agent definitions and Agent node runs. */
export type AgentPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type AgentUseSpec = {
  use: string;
  kind?: never;
  command?: never;
  model?: string;
  config?: Record<string, string>;
  permissionMode?: AgentPermissionMode;
  trace?: boolean;
  cwd?: string;
  env?: StaticEnvInput;
};

export type AgentCommandSpec = {
  command: string;
  kind?: never;
  use?: never;
  model?: string;
  config?: Record<string, string>;
  permissionMode?: AgentPermissionMode;
  trace?: boolean;
  cwd?: string;
  env?: StaticEnvInput;
};

/** Top-level workflow agent definition keyed by the workflow's `agents` map. */
export type AgentDefinitionSpec = AgentUseSpec | AgentCommandSpec;

export type AgentToken<Key extends string = string> = {
  readonly [AGENT_TOKEN]: true;
  readonly key: Key;
};

export function agentToken<Key extends string>(key: Key): AgentToken<Key> {
  return { [AGENT_TOKEN]: true as const, key };
}

type AgentStepBase = {
  agent: AgentToken;
  prompt: Resolvable<string>;
  permissionMode?: AgentPermissionMode;
  sessionKey?: Resolvable<string>;
  cwd?: Resolvable<string>;
  env?: EnvInput;
  timeout?: Resolvable<string>;
};

/** Authoring spec for an Agent node. Schema-backed agents return parsed JSON; schema-less agents return text. */
export type AgentStepSpec<
  OutSchema extends Schema<any> | undefined = Schema<any> | undefined,
> = AgentStepBase & (OutSchema extends Schema<any> ? {
  outputSchema: OutSchema;
} : {
  outputSchema?: undefined;
});

function agentDefinitionToIR(spec: AgentDefinitionSpec): AgentDefinitionIR {
  const options = {
    model: spec.model,
    config: spec.config,
    permissionMode: spec.permissionMode,
    trace: spec.trace,
    cwd: spec.cwd,
    env: spec.env,
  };
  if (spec.command !== undefined) {
    return stripUndefined({
      kind: "agent_command",
      command: spec.command,
      ...options,
    }) as AgentDefinitionIR;
  }
  return stripUndefined({
    kind: "agent_definition",
    use: spec.use,
    ...options,
  }) as AgentDefinitionIR;
}

export function lowerAgentDefinitions(
  agents: Record<string, AgentDefinitionSpec> | undefined,
  diagnostics: DiagnosticIR[],
): Record<string, AgentDefinitionIR> {
  const definitions: Array<[string, AgentDefinitionIR]> = [];
  for (const [name, value] of Object.entries((agents ?? {}) as Record<string, unknown>)) {
    const definition = lowerAgentDefinition(name, value, diagnostics);
    if (definition) definitions.push([name, definition]);
  }
  return Object.fromEntries(definitions);
}

function lowerAgentDefinition(
  name: string,
  value: unknown,
  diagnostics: DiagnosticIR[],
): AgentDefinitionIR | undefined {
  const path = `agents.${name}`;
  if (!isRecord(value)) {
    invalidAgentDefinition(diagnostics, path, `Agent '${name}' definition must be an object.`);
    return undefined;
  }
  if (value.kind !== undefined) {
    invalidAgentDefinition(diagnostics, `${path}.kind`, `Agent '${name}' definition must be a plain authoring spec, not an IR object.`);
    return undefined;
  }

  const hasUse = value.use !== undefined;
  const hasCommand = value.command !== undefined;
  if (hasUse === hasCommand) {
    invalidAgentDefinition(diagnostics, path, `Agent '${name}' definition must set exactly one of use or command.`);
    return undefined;
  }

  let invalid = false;
  const reject = (fieldPath: string, message: string) => {
    invalid = true;
    invalidAgentDefinition(diagnostics, fieldPath, message);
  };
  if (value.agentMode !== undefined) {
    reject(`${path}.agentMode`, `Agent '${name}' agentMode is not supported.`);
  }
  if (value.config !== undefined) {
    if (!isRecord(value.config)) {
      reject(`${path}.config`, `Agent '${name}' config must be an object.`);
    } else {
      for (const [key, configValue] of Object.entries(value.config)) {
        if (typeof configValue !== "string") {
          reject(`${path}.config.${key}`, `Agent '${name}' config '${key}' must be a string.`);
        }
      }
    }
  }
  if (value.permissionMode !== undefined && value.permissionMode !== "approve-reads" && value.permissionMode !== "approve-all" && value.permissionMode !== "deny-all") {
    reject(`${path}.permissionMode`, `Agent '${name}' permissionMode must be approve-reads, approve-all, or deny-all.`);
  }
  if (value.trace !== undefined && typeof value.trace !== "boolean") {
    reject(`${path}.trace`, `Agent '${name}' trace must be a boolean.`);
  }
  if (invalid) return undefined;

  if (hasUse) {
    if (typeof value.use !== "string" || value.use.length === 0) {
      invalidAgentDefinition(diagnostics, `${path}.use`, `Agent '${name}' use must be a non-empty string.`);
      return undefined;
    }
  } else if (typeof value.command !== "string" || value.command.length === 0) {
    invalidAgentDefinition(diagnostics, `${path}.command`, `Agent '${name}' command must be a non-empty string.`);
    return undefined;
  }
  return agentDefinitionToIR(value as AgentDefinitionSpec);
}

function invalidAgentDefinition(diagnostics: DiagnosticIR[], path: string, message: string): void {
  diagnostics.push({ code: "A002", severity: "error", message, path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function agentSpecToRunIR(spec: AgentStepBase): AgentRunIR {
  return stripUndefined({
    agent: spec.agent.key,
    prompt: valueToExprIR(spec.prompt),
    permissionMode: spec.permissionMode,
    sessionKey: spec.sessionKey === undefined ? undefined : valueToExprIR(spec.sessionKey),
    cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
    env: spec.env === undefined ? undefined : envToIR(spec.env),
  }) as AgentRunIR;
}

export function buildAgentNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: AgentStepSpec<OutSchema>,
): AgentNodeIR {
  return stripUndefined({
    id,
    kind: "agent",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: agentSpecToRunIR(spec),
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
  }) as AgentNodeIR;
}
