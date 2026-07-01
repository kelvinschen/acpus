import type { AgentDefinitionIR, AgentNodeIR, WorkflowIR } from "@acpus/core/ir";
import { AgentProviderRequiredError, executeAgentRequest } from "@acpus/agent-executor";
import { evaluateExpr, renderTemplate, type EvaluationScope } from "../evaluation/evaluator.js";
import { normalizeValue } from "../evaluation/schema.js";

export type AgentExecutorOptions = {
  cwd: string;
  runId?: string;
  agents: WorkflowIR["agents"];
  getProviderCommand(use: string): string | undefined;
  nodeKey?: string;
  attemptNo?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
};

export async function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<unknown> {
  const definition = options.agents[node.run.agent];
  if (!definition) throw new Error(`Agent '${node.run.agent}' is not declared.`);
  const prompt = renderTemplate(node.run.prompt, scope);
  const acceptOutput = (output: unknown): unknown => normalizeValue(node.outputSchema, output as any, `Node '${node.id}' output`);
  if (definition.kind === "agent_definition") {
    if (definition.use === "mock") return executeAgentRequest({ kind: "mock", prompt, acceptOutput });
    const command = options.getProviderCommand(definition.use);
    if (!command) throw new AgentProviderRequiredError(`Agent '${node.run.agent}' requires an agent provider adapter.`);
    return executeCommandBackedAgent(node, scope, options, {
      command,
      definitionCwd: definition.cwd,
      definitionEnv: definition.env,
      prompt,
      scrubEnv: ["ACPUS_AGENT_MODEL"],
      extraEnv: {
        ACPUS_AGENT_PROVIDER: definition.use,
        ...(definition.model ? { ACPUS_AGENT_MODEL: definition.model } : {}),
      },
      acceptOutput,
    });
  }
  return executeCommandBackedAgent(node, scope, options, {
    command: definition.command,
    definitionCwd: definition.cwd,
    definitionEnv: definition.env,
    prompt,
    acceptOutput,
  });
}

async function executeCommandBackedAgent(
  node: AgentNodeIR,
  scope: EvaluationScope,
  options: AgentExecutorOptions,
  commandInput: {
    command: string;
    definitionCwd: AgentDefinitionIR["cwd"];
    definitionEnv: AgentDefinitionIR["env"];
    prompt: string;
    acceptOutput(output: unknown): unknown;
    extraEnv?: Record<string, string>;
    scrubEnv?: string[];
  },
): Promise<unknown> {
  const cwd = node.run.cwd ? stringValue(evaluateExpr(node.run.cwd, scope), "agent cwd") : commandInput.definitionCwd ? stringValue(evaluateExpr(commandInput.definitionCwd, scope), "agent cwd") : options.cwd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...evaluateEnv(commandInput.definitionEnv, scope),
    ...evaluateEnv(node.run.env, scope),
    ...commandInput.extraEnv,
  };
  for (const key of commandInput.scrubEnv ?? []) {
    if (!(key in (commandInput.extraEnv ?? {}))) delete env[key];
  }
  applyRuntimeAgentEnv(env, node.id, options);
  const output = await executeAgentRequest({
    kind: "command",
    nodeId: node.id,
    command: commandInput.command,
    prompt: commandInput.prompt,
    cwd,
    env,
    maxAttempts: options.maxAttempts ?? Math.max(1, (node.retry?.max ?? 0) + 1),
    ...(node.timeout ? { timeout: node.timeout } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    acceptOutput: commandInput.acceptOutput,
  });
  return output;
}

function applyRuntimeAgentEnv(env: NodeJS.ProcessEnv, nodeId: string, options: AgentExecutorOptions): void {
  env.ACPUS_RUNTIME_NODE_ID = nodeId;
  setOptionalEnv(env, "ACPUS_RUNTIME_RUN_ID", options.runId);
  setOptionalEnv(env, "ACPUS_RUNTIME_NODE_KEY", options.nodeKey);
  setOptionalEnv(env, "ACPUS_RUNTIME_ATTEMPT", options.attemptNo === undefined ? undefined : String(options.attemptNo));
}

function setOptionalEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function evaluateEnv(env: Record<string, any> | undefined, scope: EvaluationScope): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (value && typeof value === "object" && value.kind === "secret") throw new Error(`Agent env '${key}' references an unresolved secret.`);
    return [key, stringValue(evaluateExpr(value, scope), `agent env ${key}`)];
  }));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} must evaluate to string.`);
}
