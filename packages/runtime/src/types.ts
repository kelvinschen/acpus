import type { IrNodeKind } from "@acpus/core";

// ─── Node lifecycle ──────────────────────────────────────────────

/** The 6 states in the unified node state machine. */
export type NodeState = "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";

/** Run-level status (mirrors terminal node states + "running"). */
export type RunStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

// ─── Node key ────────────────────────────────────────────────────

/** Dynamic dimensions that make a node key unique at runtime. */
export interface NodeKeyDynamic {
  loopRound?: number;
  fanoutItemId?: string;
  laneId?: string;
  parallelBranchId?: string;
}

// ─── Per-node persisted state ────────────────────────────────────

export interface NodeExecutionState {
  /** Resolved key string (e.g. "workflow/mapped/item:file-a/lane:0") */
  nodeKey: string;
  /** Original IR node id (e.g. "mapped") */
  nodeId: string;
  /** Node kind from IR */
  kind: IrNodeKind;
  /** Current state in the state machine */
  state: NodeState;
  /** How many times this node has been attempted */
  attempt: number;
  /** ISO timestamp when node entered running state */
  startedAt?: string;
  /** ISO timestamp when node entered a terminal state */
  completedAt?: string;
  /** Error message if state is "failed" */
  error?: string;
  /** Node output (validated against schema for agents) */
  output?: unknown;
  /** References to artifacts stored for this node */
  artifactRefs?: string[];
}

// ─── Run-level metadata ─────────────────────────────────────────

export interface RunState {
  runId: string;
  workflowName: string;
  status: RunStatus;
  /** SHA-256 digest of the frozen IR JSON */
  irDigest: string;
  /** SHA-256 digest of the input JSON */
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
  /** Node states included when inspecting a specific run (GET /runs/:runId) */
  nodes?: NodeExecutionState[];
}

// ─── Expression evaluation context ──────────────────────────────

export interface ExpressionContext {
  input: Record<string, unknown>;
  /** Step outputs keyed by step id */
  steps: Record<string, unknown>;
  loop?: { iter: number; last?: unknown };
  item?: unknown;
  item_id?: string;
  item_index?: number;
  run_id: string;
}

// ─── Executor adapter contract ──────────────────────────────────

export interface ExecutorResult {
  output?: unknown;
  exitCode?: number;
  artifactRefs?: string[];
  error?: string;
  /** True if the executor was aborted mid-execution */
  partial?: boolean;
}

export interface ExecutorAdapter {
  execute(node: unknown, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult>;
}

// ─── Artifact references ────────────────────────────────────────

export interface ArtifactRef {
  /** Full URI: artifact://runs/<runId>/nodes/<nodeKey>/<filename> */
  uri: string;
  runId: string;
  nodeKey: string;
  filename: string;
}

// ─── Interpreter control ────────────────────────────────────────

export interface InterpreterOptions {
  /** Maximum concurrent node executions across the interpreter */
  maxConcurrency?: number;
  /** Deterministic timestamp for now() in expressions (ISO string) */
  nowTimestamp?: string;
}

export interface RunOptions {
  /** Resolved input values */
  input: Record<string, unknown>;
  /** Unique run identifier (generated if not provided) */
  runId?: string;
}

// ─── Daemon types ───────────────────────────────────────────────

export interface DaemonConfig {
  /** Port to listen on (default 3839) */
  port?: number;
  /** Host to bind (default "127.0.0.1") */
  host?: string;
  /** Base directory for .acpus/ state (default cwd) */
  stateDir?: string;
}

export interface StartRunRequest {
  /** YAML source of the workflow spec */
  spec: string;
  /** Resolved input values */
  input?: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  workflowName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}
