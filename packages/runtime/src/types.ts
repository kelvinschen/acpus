import type { IrNodeKind } from "@acpus/core";

// ─── Node lifecycle ──────────────────────────────────────────────

/** The 7 states in the unified node state machine. */
export type NodeState = "pending" | "running" | "awaiting" | "completed" | "failed" | "paused" | "cancelled";

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
  /**
   * Snapshot of the parent dynamic value-context this node executed under
   * (fanout item / loop round). Persisted so retry/continuation can rebuild the
   * expression context for command/prompt re-rendering. Only value context is
   * stored — never large artifact payloads.
   */
  dynamicContext?: NodeDynamicContext;
  /** The prompt after template evaluation at runtime (persisted for TUI display). */
  renderedPrompt?: string;
}

/** Persisted parent value-context for a leaf node (fanout item / loop round). */
export interface NodeDynamicContext {
  item?: unknown;
  item_id?: string;
  item_index?: number;
  loop?: { iter: number; last?: unknown };
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
  /** Run generation: starts at 1 and increments on each Run-level retry. */
  runAttempt: number;
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

/**
 * Classification of an executor failure. Used by the interpreter to decide
 * whether a node is non-recoverable (→ failed) and whether an agent failure
 * is retryable (parse/schema).
 */
export type FailureKind = "parse" | "schema" | "spawn" | "timeout" | "killed" | "capture" | "exit";

export interface ExecutorResult {
  output?: unknown;
  exitCode?: number;
  artifactRefs?: string[];
  error?: string;
  /** Fully rendered prompt/request text prepared for this executor call. */
  prompt?: string;
  /** Human-readable response text reconstructed from the executor protocol/output. */
  responseText?: string;
  /** Raw process stdout, captured as an artifact by the interpreter. */
  stdout?: string;
  /** Raw process stderr, captured as an artifact by the interpreter. */
  stderr?: string;
  /** Failure classification when execution did not succeed. */
  failureKind?: FailureKind;
  /** True if the executor was aborted mid-execution */
  partial?: boolean;
  /** The prompt after template evaluation at runtime. */
  renderedPrompt?: string;
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
  /** Injectable sleep used for retry backoff (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  /** Resolved input values */
  input: Record<string, unknown>;
  /** Unique run identifier (generated if not provided) */
  runId?: string;
}

// ─── Supervisor types ────────────────────────────────────────────

export interface SupervisorConfig {
  /** Port to listen on (0 = random) */
  port?: number;
  /** Host to bind (default "127.0.0.1") */
  host?: string;
  /** Base directory for .acpus/ state (default cwd) */
  stateDir?: string;
  /** Idle shutdown timeout in milliseconds (default 5 min) */
  idleTimeoutMs?: number;
}

export interface SupervisorMetadata {
  schemaVersion: number;
  workspace: string;
  pid: number;
  endpoint: string;
  startedAt: string;
  version: string;
}

export interface SupervisorHealth extends SupervisorMetadata {
  ok: true;
  runningCount: number;
  activeClients: number;
}

export interface StartRunRequest {
  /** YAML source of the workflow spec */
  spec: string;
  /** Resolved input values */
  input?: Record<string, unknown>;
  /** Absolute path to the spec file (for $include/subworkflow resolution) */
  sourcePath?: string;
}

export interface RunSummary {
  runId: string;
  workflowName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

// ─── Input validation ─────────────────────────────────────────────

export interface InputValidationError {
  /** JSON pointer path, e.g. "/region" or "/tags/0" */
  path: string;
  /** Ajv keyword that triggered the error, e.g. "required", "type" */
  keyword: string;
  /** Human-readable error message */
  message: string;
  /** Expected type or value (when applicable) */
  expected?: string;
  /** Actual type or value (when applicable) */
  actual?: string;
}

// ─── Replay ─────────────────────────────────────────────────────

/** A single discrepancy found while replaying a persisted Run. */
export interface ReplayMismatch {
  nodeKey: string;
  /** What kind of discrepancy: a node reached in only one walk, or differing state. */
  kind: "state" | "missing-in-replay" | "unexpected-in-replay";
  /** Persisted (recorded) value. */
  expected?: NodeState;
  /** Value derived by the deterministic replay walk. */
  actual?: NodeState;
}

/**
 * Result of a deterministic replay: re-walking the frozen IR against recorded
 * node outputs and verifying the reconstructed node topology (the set of reached
 * node keys) matches what was persisted. No agents/programs are executed and no
 * disk writes occur.
 */
export interface ReplayResult {
  runId: string;
  ok: boolean;
  mismatches: ReplayMismatch[];
}
