import type { ExprIR, JsonPrimitive, JsonValue } from "@acpus/expression/ir";
export type { ExprIR, JsonArray, JsonObject, JsonPrimitive, JsonValue, TemplateIR, TemplatePartIR, TypeIR } from "@acpus/expression/ir";

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

export type AgentRetryIR = {
  max?: ExprIR;
};

export type SecretRefIR = {
  kind: "secret";
  name: string;
};

export type AgentDefinitionIR =
  | {
      kind: "agent_definition";
      use: string;
      model?: string;
      permissionMode?: "approve-reads" | "approve-all" | "deny-all";
      agentMode?: string;
      cwd?: string;
      env?: Record<string, string | SecretRefIR>;
    }
  | {
      kind: "agent_command";
      command: string;
      model?: string;
      permissionMode?: "approve-reads" | "approve-all" | "deny-all";
      agentMode?: string;
      cwd?: string;
      env?: Record<string, string | SecretRefIR>;
    };

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
  source?: SourceLocationIR;
};

export type AgentNodeIR = BaseNodeIR & {
  kind: "agent";
  outputSchema?: SchemaIR;
  run: AgentRunIR;
  timeout?: ExprIR;
  retry?: AgentRetryIR;
};

export type AgentRunIR = {
  kind: "agent_run";
  agent: string;
  prompt: ExprIR;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  sessionKey?: ExprIR;
  cwd?: ExprIR;
  env?: Record<string, ExprIR | SecretRefIR>;
};

export type TaskNodeIR = BaseNodeIR & {
  kind: "task";
  run: TaskRunIR;
  timeout?: ExprIR;
};

export type TaskRunIR = {
  kind: "task_run";
  input: Record<string, ExprIR>;
  target: TaskExecutionTargetIR;
  cwd?: ExprIR;
  env?: Record<string, ExprIR | SecretRefIR>;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: ExprIR;
    commandRunner?: "acpus-zx-core" | "custom";
  };
};

export type TaskExecutionTargetIR =
  | {
      kind: "inline";
      runtime: "node";
      source: string;
    }
  | {
      kind: "module";
      runtime: "node";
      specifier: string;
      exportName: string;
      referrer: {
        kind: "workflow";
        path: string;
      };
    };

export type SignalNodeIR = BaseNodeIR & {
  kind: "signal";
  outputSchema?: SchemaIR;
  run: SignalRunIR;
  timeout?: ExprIR;
  onTimeout?: { action: "fail"; message?: ExprIR };
};

export type SignalRunIR = {
  kind: "signal_run";
  prompt: ExprIR;
};

export type AssertNodeIR = BaseNodeIR & {
  kind: "assert";
  condition: ExprIR;
  message?: ExprIR;
};

export type ScopeIR = {
  nodes: NodeIR[];
  outputs?: Record<string, ExprIR>;
};

export type LoopTransitionScopeIR = Omit<ScopeIR, "outputs"> & {
  outputs: {
    state: ExprIR;
    stop: ExprIR;
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

export type ParallelBranchIR = {
  scope: ScopeIR;
};

export type ParallelNodeIR = BaseNodeIR & {
  kind: "parallel";
  branches: Record<string, ParallelBranchIR>;
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

export type WorkflowLockIR = {
  acpusCoreVersion: string;
  workflowSource?: string;
  workflowSourceDigest?: string;
  generatedAt: string;
  notes: string[];
};

export type WorkflowIR = {
  irVersion: 3;
  name: string;
  description?: string;
  inputSchema?: SchemaIR;
  agents: Record<string, AgentDefinitionIR>;
  root: ScopeIR;
  outputs: Record<string, ExprIR>;
  lock: WorkflowLockIR;
  diagnostics: DiagnosticIR[];
};

export type DiagnosticIR = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  source?: SourceLocationIR;
  hint?: string;
};
