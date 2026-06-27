export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TypeIR =
  | { kind: "unknown" }
  | { kind: "string" }
  | { kind: "integer" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "path" }
  | { kind: "artifact"; mediaType?: string }
  | { kind: "secret_ref" }
  | { kind: "literal"; value: JsonPrimitive }
  | { kind: "enum"; values: JsonPrimitive[] }
  | { kind: "array"; item: TypeIR }
  | { kind: "object"; fields: Record<string, TypeIR>; required: string[]; additionalProperties: boolean }
  | { kind: "record"; key: TypeIR; value: TypeIR }
  | { kind: "union"; variants: TypeIR[] };

export type SchemaIR = TypeIR & {
  description?: string;
  default?: JsonValue;
  optional?: boolean;
  nullable?: boolean;
};

export type ExprIR =
  | { kind: "literal"; value: unknown; type?: TypeIR }
  | { kind: "ref"; path: string[]; type?: TypeIR }
  | { kind: "call"; fn: string; args: ExprIR[]; type?: TypeIR }
  | { kind: "array"; items: ExprIR[]; type?: TypeIR }
  | { kind: "object"; fields: Record<string, ExprIR>; type?: TypeIR }
  | { kind: "template"; template: TemplateIR; type?: TypeIR };

export type TemplateIR = {
  kind: "template";
  format: "markdown" | "text" | "json";
  parts: TemplatePartIR[];
};

export type TemplatePartIR =
  | { kind: "text"; value: string }
  | { kind: "expr"; expr: ExprIR; renderAs?: "text" | "json" | "artifact" };

export type DurationIR = string;

export type RetryIR = {
  max?: number;
  on?: string[];
  backoff?: "none" | "linear" | "exponential";
};

export type SecretRefIR = {
  kind: "secret";
  name: string;
};

export type AgentDefinitionIR =
  | {
      kind: "agent_definition";
      provider: string;
      model?: string;
      policy?: "read" | "full";
      cwd?: ExprIR;
      env?: Record<string, ExprIR | SecretRefIR>;
      options?: JsonObject;
    }
  | {
      kind: "agent_command";
      command: string;
      policy?: "read" | "full";
      cwd?: ExprIR;
      env?: Record<string, ExprIR | SecretRefIR>;
      options?: JsonObject;
    };

export type NodeIR =
  | AgentNodeIR
  | TaskNodeIR
  | SignalNodeIR
  | GuardNodeIR
  | IfNodeIR
  | SwitchNodeIR
  | ParallelNodeIR
  | FanoutNodeIR
  | LoopNodeIR
  | CallNodeIR;

export type BaseNodeIR = {
  id: string;
  source?: SourceLocationIR;
};

export type AgentNodeIR = BaseNodeIR & {
  kind: "agent";
  inputs: Record<string, ExprIR>;
  outputSchema?: SchemaIR;
  run: AgentRunIR;
  timeout?: DurationIR;
  retry?: RetryIR;
};

export type AgentRunIR = {
  kind: "agent_run";
  use: string;
  prompt: TemplateIR;
  policy?: "read" | "full";
  session?: { key?: TemplateIR };
  cwd?: ExprIR;
  env?: Record<string, ExprIR | SecretRefIR>;
};

export type TaskNodeIR = BaseNodeIR & {
  kind: "task";
  inputs: Record<string, ExprIR>;
  outputSchema: SchemaIR;
  run: TaskRunIR;
  params?: JsonObject;
  cwd?: ExprIR;
  env?: Record<string, ExprIR | SecretRefIR>;
  timeout?: DurationIR;
  retry?: RetryIR;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: DurationIR;
  };
};

export type TaskRunIR = {
  kind: "task_run";
  bundleId: string;
  exportName: string;
  digest: string;
  runtime: "node";
  inline?: boolean;
};

export type SignalNodeIR = BaseNodeIR & {
  kind: "signal";
  inputs: Record<string, ExprIR>;
  outputSchema: SchemaIR;
  run: SignalRunIR;
  timeout?: DurationIR;
  onTimeout?: { action: "fail" | "complete"; message?: string };
};

export type SignalRunIR = {
  kind: "signal_run";
  prompt: TemplateIR;
};

export type GuardNodeIR = BaseNodeIR & {
  kind: "guard";
  when: ExprIR;
  then?: "continue" | "fail" | "complete";
  otherwise: "continue" | "fail" | "complete";
  message?: TemplateIR;
};

export type ScopeIR = {
  nodes: NodeIR[];
  outputs?: Record<string, ExprIR>;
};

export type IfNodeIR = BaseNodeIR & {
  kind: "if";
  when: ExprIR;
  then: ScopeIR;
  otherwise?: ScopeIR;
  outputSchema?: SchemaIR;
};

export type SwitchNodeIR = BaseNodeIR & {
  kind: "switch";
  cases: Array<{ when: ExprIR; then: ScopeIR }>;
  otherwise?: ScopeIR;
  outputSchema?: SchemaIR;
};

export type ParallelNodeIR = BaseNodeIR & {
  kind: "parallel";
  branches: Record<string, ScopeIR>;
  join?: "all" | "race";
  maxConcurrency?: number;
  outputSchema?: SchemaIR;
};

export type FanoutNodeIR = BaseNodeIR & {
  kind: "fanout";
  over: ExprIR;
  itemSchema?: SchemaIR;
  key?: TemplateIR;
  do: ScopeIR;
  join?: "all" | "race" | "quorum";
  maxConcurrency?: number;
  quorum?: number;
  outputSchema?: SchemaIR;
};

export type LoopNodeIR = BaseNodeIR & {
  kind: "loop";
  maxIterations: number;
  do: ScopeIR;
  until: ExprIR;
  onMaxIterations?: "fail" | "complete";
  outputSchema?: SchemaIR;
};

export type CallNodeIR = BaseNodeIR & {
  kind: "call";
  workflow: string;
  inputs: Record<string, ExprIR>;
  outputSchema?: SchemaIR;
};

export type TaskBundleIR = {
  id: string;
  digest: string;
  runtime: "node";
  source?: string;
  sourceFile?: string;
  inline?: boolean;
  note?: string;
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
  taskBundleDigests: Record<string, string>;
  generatedAt: string;
  notes: string[];
};

export type WorkflowIR = {
  irVersion: 2;
  name: string;
  inputSchema?: SchemaIR;
  agents: Record<string, AgentDefinitionIR>;
  root: ScopeIR;
  outputs: Record<string, ExprIR>;
  assets: {
    taskBundles: Record<string, TaskBundleIR>;
  };
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
