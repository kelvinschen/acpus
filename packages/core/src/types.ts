export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path: string;
}

export interface CompileOptions {
  sourcePath?: string;
  strict?: boolean;
  includeResolver?: (path: string, fromPath?: string) => string;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  ir?: AcpusIr;
  schedule?: ScheduleSummary;
}

export interface LintResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface WorkflowSpec {
  version: number;
  name: string;
  description?: string;
  input?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  agents?: Record<string, AgentSpec>;
  workflow: {
    steps: WorkflowStep[];
  };
  outputs?: Record<string, unknown>;
}

export interface AgentSpec {
  type: string;
  model?: string;
  cwd?: unknown;
  env?: Record<string, unknown>;
  tools_allowlist?: string[];
  max_concurrency?: number;
  mock_script?: string;
}

export type WorkflowStep = Record<string, unknown> & {
  id?: string;
};

export type IrNodeKind =
  | "pipeline"
  | "run.agent"
  | "run.program"
  | "parallel"
  | "fanout"
  | "switch"
  | "loop"
  | "approval"
  | "subworkflow";

export interface AcpusIr {
  irVersion: 1;
  astVersion: 1;
  source: {
    path?: string;
    digest: string;
  };
  name: string;
  description?: string;
  input: Record<string, unknown>;
  defaults: Record<string, unknown>;
  agents: Record<string, AgentSpec>;
  root: IrNode;
  outputs: Record<string, unknown>;
  expressions: IrExpression[];
  runtimeInput?: Record<string, unknown>;
}

export type OutputMerge = "map" | "array" | "selected" | "last";

export interface IrNode {
  id: string;
  kind: IrNodeKind;
  nodePath: string[];
  keyTemplate: NodeKeyTemplate;
  outputMerge?: OutputMerge;
  children?: IrNode[];
  branches?: IrBranch[];
  metadata: Record<string, unknown>;
}

export interface IrBranch {
  id: string;
  when?: string;
  children: IrNode[];
}

export interface NodeKeyTemplate {
  astVersion: 1;
  nodePath: string;
  loopRound?: true;
  fanoutItemId?: true;
  parallelBranchId?: true;
  laneId?: true;
}

export interface IrExpression {
  id: string;
  source: string;
  path: string;
  references: string[];
}

export interface ScheduleSummary {
  workflow: string;
  nodes: ScheduleNode[];
}

export interface ScheduleNode {
  id: string;
  kind: IrNodeKind;
  nodePath: string;
  outputMerge?: OutputMerge;
  children?: ScheduleNode[];
  branches?: Array<{
    id: string;
    when?: string;
    children: ScheduleNode[];
  }>;
}
