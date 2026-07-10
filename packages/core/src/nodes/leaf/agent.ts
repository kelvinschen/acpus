import { envToIR, staticEnvToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
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
  permissionMode?: AgentPermissionMode;
  agentMode?: string;
  policy?: never;
  options?: never;
  cwd?: string;
  env?: StaticEnvInput;
};

export type AgentCommandSpec = {
  command: string;
  kind?: never;
  use?: never;
  model?: string;
  permissionMode?: AgentPermissionMode;
  agentMode?: string;
  policy?: never;
  options?: never;
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

export type AgentRunSpec = {
  agent: AgentToken;
  prompt: Resolvable<string>;
  permissionMode?: AgentPermissionMode;
  policy?: never;
  sessionKey?: Resolvable<string>;
  cwd?: Resolvable<string>;
  env?: EnvInput;
};

export type AgentRetrySpec = {
  max?: Resolvable<number>;
};

/** Authoring spec for an Agent node. Schema-backed agents return parsed JSON; schema-less agents return text. */
export type AgentStepSpec<
  OutSchema extends Schema<any> | undefined = Schema<any> | undefined,
> = (OutSchema extends Schema<any> ? {
  outputSchema: OutSchema;
  run: AgentRunSpec;
  timeout?: Resolvable<string>;
  retry?: AgentRetrySpec;
} : {
  outputSchema?: undefined;
  run: AgentRunSpec;
  timeout?: Resolvable<string>;
  retry?: never;
});

export function agentDefinitionToIR(spec: AgentDefinitionSpec): AgentDefinitionIR {
  if (spec.command !== undefined) {
    return stripUndefined({
      kind: "agent_command",
      command: spec.command,
      model: spec.model,
      permissionMode: spec.permissionMode,
      agentMode: spec.agentMode,
      cwd: spec.cwd,
      env: staticEnvToIR(spec.env),
    }) as AgentDefinitionIR;
  }
  return stripUndefined({
    kind: "agent_definition",
    use: spec.use,
    model: spec.model,
    permissionMode: spec.permissionMode,
    agentMode: spec.agentMode,
    cwd: spec.cwd,
    env: staticEnvToIR(spec.env),
  }) as AgentDefinitionIR;
}

function agentRunToIR(spec: AgentRunSpec): AgentRunIR {
  return stripUndefined({
    kind: "agent_run",
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
  diagnostics: DiagnosticIR[],
): AgentNodeIR {
  assertStableId(id, diagnostics);
  if ((spec.run as { policy?: unknown }).policy !== undefined) {
    diagnostics.push({ code: "A003", severity: "error", message: `Agent node '${id}' run must use permissionMode, not policy.`, path: `root.nodes.${id}.run.policy` });
  }
  return stripUndefined({
    id,
    kind: "agent",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: agentRunToIR(spec.run),
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
    retry: spec.retry === undefined ? undefined : {
      max: spec.retry.max === undefined ? undefined : valueToExprIR(spec.retry.max),
    },
  }) as AgentNodeIR;
}
