import { AGENT_DEF, AGENT_RUN } from "../../internal/symbols.js";
import { envToIR, inputsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type Template } from "../../template/template.js";
import { valueToExprIR } from "../../expressions/expr.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { AgentDefinitionIR, AgentNodeIR, AgentRunIR, DiagnosticIR, JsonObject, RetryIR } from "../../ir/types.js";
import type { GraphInput, StepInput } from "./shared.js";

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
  prompt: Template | string;
  policy?: "read" | "full";
  session?: { key?: Template | string };
  cwd?: unknown;
  env?: Record<string, unknown>;
};

export type AgentStepSpec<Input extends StepInput, OutSchema extends Schema<any> | undefined = Schema<any> | undefined> = {
  input: Input;
  output?: OutSchema;
  run: (ctx: { input: GraphInput<Input> }) => AgentRunSpec;
  timeout?: string;
  retry?: RetryIR;
};

export type AgentRun = {
  readonly [AGENT_RUN]: true;
  readonly spec: AgentRunSpec;
  toIR(): AgentRunIR;
};

function makeAgentDefinition(ir: AgentDefinitionIR): AgentDefinition {
  return { [AGENT_DEF]: true as const, ir };
}

function makeRun(spec: AgentRunSpec): AgentRun {
  return {
    [AGENT_RUN]: true as const,
    spec,
    toIR(): AgentRunIR {
      const session = spec.session?.key === undefined ? undefined : { key: templateToIR(spec.session.key) };
      const ir: AgentRunIR = {
        kind: "agent_run",
        use: spec.use,
        prompt: templateToIR(spec.prompt),
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

export function buildAgentNode<const Input extends StepInput, OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: AgentStepSpec<Input, OutSchema>,
  diagnostics: DiagnosticIR[],
): AgentNodeIR {
  assertStableId(id, diagnostics);
  const run = agent(spec.run({ input: spec.input }));
  return stripUndefined({
    id,
    kind: "agent",
    inputs: inputsToIR(spec.input),
    outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
    run: run.toIR(),
    timeout: spec.timeout,
    retry: spec.retry,
  }) as AgentNodeIR;
}
