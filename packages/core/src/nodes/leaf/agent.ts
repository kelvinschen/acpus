import { envToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type TemplateInput } from "../../template/template.js";
import { valueToExprIR } from "@acpus/expression/ir";
import { AGENT_TOKEN } from "../../internal/symbols.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { WorkflowValue } from "@acpus/expression";
import type { AgentDefinitionIR, AgentNodeIR, AgentRunIR, DiagnosticIR, RetryIR } from "../../ir/types.js";
import type { EnvInput } from "./shared.js";

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
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
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
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
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
  permissionMode?: AgentPermissionMode;
  policy?: never;
  session?: { key?: TemplateInput };
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
};

export type AgentStepSpec<
  OutSchema extends Schema<any> | undefined = Schema<any> | undefined,
> = (OutSchema extends Schema<any> ? {
  outputSchema: OutSchema;
  run: AgentRunSpec;
  timeout?: string;
  retry?: RetryIR;
} : {
  outputSchema?: undefined;
  run: AgentRunSpec;
  timeout?: string;
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
      cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
      env: spec.env === undefined ? undefined : envToIR(spec.env),
    }) as AgentDefinitionIR;
  }
  return stripUndefined({
    kind: "agent_definition",
    use: spec.use,
    model: spec.model,
    permissionMode: spec.permissionMode,
    agentMode: spec.agentMode,
    cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
    env: spec.env === undefined ? undefined : envToIR(spec.env),
  }) as AgentDefinitionIR;
}

function agentRunToIR(spec: AgentRunSpec): AgentRunIR {
  return stripUndefined({
    kind: "agent_run",
    agent: spec.agent.key,
    prompt: templateToIR(spec.prompt),
    permissionMode: spec.permissionMode,
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
  if ((spec.run as { policy?: unknown }).policy !== undefined) {
    diagnostics.push({ code: "A003", severity: "error", message: `Agent node '${id}' run must use permissionMode, not policy.`, path: `root.nodes.${id}.run.policy` });
  }
  return stripUndefined({
    id,
    kind: "agent",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: agentRunToIR(spec.run),
    timeout: spec.timeout,
    retry: spec.retry,
  }) as AgentNodeIR;
}
