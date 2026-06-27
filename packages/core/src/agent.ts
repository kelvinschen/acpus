import { AGENT_DEF, AGENT_RUN } from "./internal.js";
import { secretOrExprToIR } from "./runtime.js";
import { templateToIR, type Template } from "./template.js";
import { valueToExprIR } from "./expr.js";
import type { AgentDefinitionIR, AgentRunIR, JsonObject } from "./ir.js";

export type AgentDefinition = {
  readonly [AGENT_DEF]: true;
  readonly ir: AgentDefinitionIR;
};

export type AgentDefinitionSpec = {
  provider: string;
  model?: string;
  policy?: "read" | "full";
  cwd?: unknown;
  env?: Record<string, unknown>;
  options?: JsonObject;
};

export type AgentCommandDefinitionSpec = {
  command: string;
  policy?: "read" | "full";
  cwd?: unknown;
  env?: Record<string, unknown>;
  options?: JsonObject;
};

export type AgentRunSpec = {
  use: string;
  prompt: Template | string | ((input: any) => Template | string);
  policy?: "read" | "full";
  session?: { key?: Template | string };
  cwd?: unknown;
  env?: Record<string, unknown>;
};

export type AgentRun = {
  readonly [AGENT_RUN]: true;
  readonly spec: AgentRunSpec;
  toIR(input: Record<string, unknown>): AgentRunIR;
};

function envToIR(env: Record<string, unknown>) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(env)) out[key] = secretOrExprToIR(value);
  return out;
}

function makeAgentDefinition(ir: AgentDefinitionIR): AgentDefinition {
  return { [AGENT_DEF]: true as const, ir };
}

function makeRun(spec: AgentRunSpec): AgentRun {
  return {
    [AGENT_RUN]: true as const,
    spec,
    toIR(input: Record<string, unknown>): AgentRunIR {
      const promptValue = typeof spec.prompt === "function" ? spec.prompt(input) : spec.prompt;
      const session = spec.session?.key === undefined ? undefined : { key: templateToIR(spec.session.key) };
      const ir: AgentRunIR = {
        kind: "agent_run",
        use: spec.use,
        prompt: templateToIR(promptValue),
        ...(spec.policy === undefined ? {} : { policy: spec.policy }),
        ...(session === undefined ? {} : { session }),
        ...(spec.cwd === undefined ? {} : { cwd: valueToExprIR(spec.cwd) }),
        ...(spec.env === undefined ? {} : { env: envToIR(spec.env) }),
      };
      return ir;
    },
  };
}

export type AgentFactory = {
  (spec: AgentRunSpec): AgentRun;
  define(spec: AgentDefinitionSpec): AgentDefinition;
  command(spec: AgentCommandDefinitionSpec): AgentDefinition;
  builtin(provider: string, options?: Omit<AgentDefinitionSpec, "provider">): AgentDefinition;
  isRun(value: unknown): value is AgentRun;
  isDefinition(value: unknown): value is AgentDefinition;
};

export const agent: AgentFactory = Object.assign(
  (spec: AgentRunSpec) => makeRun(spec),
  {
    define(spec: AgentDefinitionSpec): AgentDefinition {
      return makeAgentDefinition({
        kind: "agent_definition",
        provider: spec.provider,
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.policy === undefined ? {} : { policy: spec.policy }),
        ...(spec.cwd === undefined ? {} : { cwd: valueToExprIR(spec.cwd) }),
        ...(spec.env === undefined ? {} : { env: envToIR(spec.env) }),
        ...(spec.options === undefined ? {} : { options: spec.options }),
      });
    },
    command(spec: AgentCommandDefinitionSpec): AgentDefinition {
      return makeAgentDefinition({
        kind: "agent_command",
        command: spec.command,
        ...(spec.policy === undefined ? {} : { policy: spec.policy }),
        ...(spec.cwd === undefined ? {} : { cwd: valueToExprIR(spec.cwd) }),
        ...(spec.env === undefined ? {} : { env: envToIR(spec.env) }),
        ...(spec.options === undefined ? {} : { options: spec.options }),
      });
    },
    builtin(provider: string, options?: Omit<AgentDefinitionSpec, "provider">): AgentDefinition {
      return this.define({ provider, ...(options ?? {}) });
    },
    isRun(value: unknown): value is AgentRun {
      return Boolean(value && typeof value === "object" && (value as any)[AGENT_RUN]);
    },
    isDefinition(value: unknown): value is AgentDefinition {
      return Boolean(value && typeof value === "object" && (value as any)[AGENT_DEF]);
    },
  },
);
