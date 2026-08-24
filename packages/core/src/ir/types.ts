import type { ExprIR, JsonPrimitive, JsonValue } from "@acpus/expression/ir";
export type { ExprIR, JsonArray, JsonObject, JsonPrimitive, JsonValue, TemplateIR, TemplatePartIR } from "@acpus/expression/ir";

export type SchemaTypeIR =
  | { kind: "unknown" }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "array"; item: SchemaIR }
  | { kind: "object"; fields: Record<string, SchemaIR>; required: string[]; additionalProperties: boolean }
  | { kind: "record"; value: SchemaIR }
  | { kind: "union"; variants: SchemaIR[] }
  | { kind: "literal"; value: JsonPrimitive }
  | { kind: "enum"; values: JsonPrimitive[] };

export type SchemaIR = SchemaTypeIR & {
  description?: string;
  default?: JsonValue;
  optional?: boolean;
  nullable?: boolean;
};

export type AgentDefinitionIR =
  | {
      kind: "agent_definition";
      use: string;
      model?: string;
      config?: Record<string, string>;
      permissionMode?: "approve-reads" | "approve-all" | "deny-all";
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      kind: "agent_command";
      command: string;
      model?: string;
      config?: Record<string, string>;
      permissionMode?: "approve-reads" | "approve-all" | "deny-all";
      cwd?: string;
      env?: Record<string, string>;
    };

export type AgentSlotIR = {
  kind: "agent_slot";
  model?: string;
  config?: Record<string, string>;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  cwd?: string;
  env?: Record<string, string>;
};

export type AgentDeclarationIR = AgentDefinitionIR | AgentSlotIR;

export type NodeIR =
  | AgentNodeIR
  | TaskNodeIR
  | SignalNodeIR
  | AssertNodeIR
  | IfNodeIR
  | SwitchNodeIR
  | ParallelNodeIR
  | FanoutNodeIR
  | LoopNodeIR;

export type BaseNodeIR = {
  id: string;
};

export type AgentNodeIR = BaseNodeIR & {
  kind: "agent";
  outputSchema?: SchemaIR;
  run: AgentRunIR;
  timeout?: ExprIR;
};

export type AgentRunIR = {
  agent: string;
  prompt: ExprIR;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  sessionKey?: ExprIR;
  cwd?: ExprIR;
  env?: Record<string, ExprIR>;
};

export type TaskNodeIR = BaseNodeIR & {
  kind: "task";
  run: TaskRunIR;
  timeout?: ExprIR;
};

export type TaskRunIR = {
  input: ExprIR;
  target: TaskExecutionTargetIR;
  cwd?: ExprIR;
  env?: Record<string, ExprIR>;
  execution?: {
    defaultCommandTimeout?: ExprIR;
  };
};

export type TaskExecutionTargetIR =
  | {
      kind: "inline";
      source: string;
    }
  | {
      kind: "module";
      specifier: string;
      exportName: string;
      referrer: {
        path: string;
      };
    };

export type SignalNodeIR = BaseNodeIR & {
  kind: "signal";
  outputSchema?: SchemaIR;
  run: SignalRunIR;
  timeout?: ExprIR;
  onTimeout?: { message?: ExprIR };
};

export type SignalRunIR = {
  prompt: ExprIR;
};

export type AssertNodeIR = BaseNodeIR & {
  kind: "assert";
  condition: ExprIR;
  message?: ExprIR;
};

export type ScopeIR = {
  nodes: NodeIR[];
  output: ExprIR;
};

export type LoopTransitionScopeIR = Omit<ScopeIR, "output"> & {
  output: {
    kind: "object";
    fields: {
      state: ExprIR;
      stop: ExprIR;
    };
  };
};

export type IfNodeIR = BaseNodeIR & {
  kind: "if";
  condition: ExprIR;
  then: ScopeIR;
  else: ScopeIR;
};

export type SwitchNodeIR = BaseNodeIR & {
  kind: "switch";
  cases: Array<{ when: ExprIR; then: ScopeIR }>;
  default: ScopeIR;
};

export type ParallelNodeIR = BaseNodeIR & {
  kind: "parallel";
  branches: Record<string, ScopeIR>;
  strategy: "all" | "race";
  maxConcurrency?: ExprIR;
};

type BaseFanoutNodeIR = BaseNodeIR & {
  kind: "fanout";
  over: ExprIR;
  do: ScopeIR;
  maxConcurrency?: ExprIR;
};

export type FanoutNodeIR =
  | (BaseFanoutNodeIR & { strategy: "all"; count?: never })
  | (BaseFanoutNodeIR & { strategy: "quorum"; count: ExprIR });

export type LoopNodeIR = BaseNodeIR & {
  kind: "loop";
  state: ExprIR;
  do: LoopTransitionScopeIR;
};

export type SourceLocationIR = {
  file?: string;
  line?: number;
  column?: number;
};

export type WorkflowIR = {
  irVersion: 8;
  name: string;
  description?: string;
  inputSchema?: SchemaIR;
  agents: Record<string, AgentDeclarationIR>;
  root: ScopeIR;
  diagnostics: DiagnosticIR[];
};

export type AdmittedWorkflowIR = Omit<WorkflowIR, "agents"> & {
  agents: Record<string, AgentDefinitionIR>;
};

export type DiagnosticIR = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  source?: SourceLocationIR;
  hint?: string;
};
