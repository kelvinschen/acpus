import { envToIR, staticEnvToIR, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import { AGENT_TOKEN } from "../../internal/symbols.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { Resolvable } from "@acpus/expression";
import type { AgentDefinitionIR, AgentNodeIR, AgentRunIR } from "../../ir/types.js";
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

export function agentDefinitionToIR(spec: AgentDefinitionSpec): AgentDefinitionIR {
  if (spec.command !== undefined) {
    return stripUndefined({
      kind: "agent_command",
      command: spec.command,
      model: spec.model,
      config: spec.config,
      permissionMode: spec.permissionMode,
      trace: spec.trace,
      cwd: spec.cwd,
      env: staticEnvToIR(spec.env),
    }) as AgentDefinitionIR;
  }
  return stripUndefined({
    kind: "agent_definition",
    use: spec.use,
    model: spec.model,
    config: spec.config,
    permissionMode: spec.permissionMode,
    trace: spec.trace,
    cwd: spec.cwd,
    env: staticEnvToIR(spec.env),
  }) as AgentDefinitionIR;
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
