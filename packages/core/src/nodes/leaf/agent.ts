import { envToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type TemplateInput } from "../../template/template.js";
import { valueToExprIR } from "@acpus/expression/ir";
import { AGENT_TOKEN } from "../../internal/symbols.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { WorkflowValue } from "@acpus/expression";
import type { AgentDefinitionIR, AgentNodeIR, AgentRunIR, DiagnosticIR, JsonObject, RetryIR } from "../../ir/types.js";
import type { EnvInput } from "./shared.js";

export type AgentUseSpec = {
  use: string;
  kind?: never;
  command?: never;
  model?: string;
  policy?: "read" | "full";
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
  options?: JsonObject;
};

export type AgentCommandSpec = {
  command: string;
  kind?: never;
  use?: never;
  model?: never;
  policy?: "read" | "full";
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
  options?: JsonObject;
};

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
  prompt: TemplateInput;
  policy?: "read" | "full";
  session?: { key?: TemplateInput };
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
};

export type AgentStepSpec<
  OutSchema extends Schema<any> | undefined = Schema<any> | undefined,
> = {
  outputSchema?: OutSchema;
  run: AgentRunSpec;
  timeout?: string;
  retry?: RetryIR;
};

export function agentDefinitionToIR(spec: AgentDefinitionSpec): AgentDefinitionIR {
  if (spec.command !== undefined) {
    return stripUndefined({
      kind: "agent_command",
      command: spec.command,
      policy: spec.policy,
      cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
      env: spec.env === undefined ? undefined : envToIR(spec.env),
      options: spec.options,
    }) as AgentDefinitionIR;
  }
  return stripUndefined({
    kind: "agent_definition",
    use: spec.use,
    model: spec.model,
    policy: spec.policy,
    cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
    env: spec.env === undefined ? undefined : envToIR(spec.env),
    options: spec.options,
  }) as AgentDefinitionIR;
}

function agentRunToIR(spec: AgentRunSpec): AgentRunIR {
  return stripUndefined({
    kind: "agent_run",
    agent: spec.agent.key,
    prompt: templateToIR(spec.prompt),
    policy: spec.policy,
    session: spec.session?.key === undefined ? undefined : { key: templateToIR(spec.session.key) },
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
  return stripUndefined({
    id,
    kind: "agent",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: agentRunToIR(spec.run),
    timeout: spec.timeout,
    retry: spec.retry,
  }) as AgentNodeIR;
}
