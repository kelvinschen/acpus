import type { AgentOverrideWarning, AgentOverrides, IrNodeKind } from "@acpus/core";

// ─── Node lifecycle ──────────────────────────────────────────────

/** The 7 states in the unified node state machine. */
export type NodeState = "pending" | "running" | "awaiting" | "completed" | "failed" | "paused" | "cancelled";

/** Run-level status (mirrors terminal node states + "running"). */
export type RunStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

/** Terminal Run statuses — a Run in any of these states will not transition further. */
export const RUN_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

/** Returns true when the Run status is terminal (completed, failed, or cancelled). */
export function isRunTerminal(status: RunStatus): boolean {
  return RUN_TERMINAL_STATUSES.has(status);
}

// ─── Node key ────────────────────────────────────────────────────

/** Dynamic dimensions that make a node key unique at runtime. */
export interface NodeKeyDynamic {
  loopRound?: number;
  fanoutItemId?: string;
  laneId?: string;
  parallelBranchId?: string;
  frames?: NodeKeyDynamicFrame[];
}

export interface NodeKeyDynamicFrame {
  loopRound?: number;
  fanoutItemId?: string;
  laneId?: string;
  parallelBranchId?: string;
}

// ─── Per-node persisted state ────────────────────────────────────

export interface NodeExecutionState {
  /** Resolved key string (e.g. "workflow/mapped/item:file-a/lane:0") */
  nodeKey: string;
  /** Original IR node id (not globally unique for generated internal pipelines). */
  nodeId: string;
  /** Node kind from IR */
  kind: IrNodeKind;
  /** Node Definition Hash (canonical hash of the IR Node + subtree). */
  definitionHash?: string;
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
  /** Runtime-rendered prompt (Agent or Signal Node), retained for display when compact telemetry is unavailable. */
  renderedPrompt?: string;
  /** Runtime-rendered explicit Agent session_key, when declared by the Workflow Spec. */
  renderedSessionKey?: string;
  /**
   * Snapshot of the parent dynamic value-context this node executed under
   * (fanout item / loop round). Persisted so retry/continuation can rebuild the
   * expression context for command/prompt re-rendering. Only value context is
   * stored — never large artifact payloads.
   */
  dynamicContext?: NodeDynamicContext;
  /** Compact live Agent telemetry for context, tool use, and bounded IO previews. */
  agentTelemetry?: AgentTelemetry;
}

/** Persisted parent value-context for a leaf node (fanout item / loop round). */
export interface NodeDynamicContext {
  item?: unknown;
  item_id?: string;
  item_index?: number;
  loop?: { iter: number; last?: unknown };
}

// ─── Run Checkpoint ─────────────────────────────────────────────

/**
 * An ordered, persisted record of one Node's terminal outcome within a Run.
 *
 * Run Checkpoints are the inheritance source consulted when a Forked Run
 * decides which Nodes to reuse: the Forked Run scans checkpoints in `sequence`
 * order, requires `state === "completed"`, and matches `definitionHash` against
 * the new Workflow Spec's compiled IR Node.
 */
export interface RunCheckpoint {
  /** Monotonically-increasing append order within this Run. */
  sequence: number;
  nodeKey: string;
  state: NodeState;
  /** Node Definition Hash from the IR at the time the Node ran. */
  definitionHash: string;
  /** ISO timestamp the Node entered terminal state. */
  completedAt?: string;
}

// ─── Run-level metadata ─────────────────────────────────────────

export interface RunLineage {
  /** Run ID of the immediate prior Run this Forked Run derived from. */
  sourceRunId: string;
  /** Node Key chosen as Fork Origin (default boundary or operator override). */
  forkOriginNodeKey: string;
  /** Number of Nodes inherited from the prior Run. */
  inheritedNodeCount: number;
}

export interface RunState {
  runId: string;
  workflowName: string;
  /** Catalog ref used to start this Run, when started from the Workflow Catalog. */
  workflowRef?: string;
  /** Absolute Workflow Spec path used to compile this Run. */
  workflowSourcePath?: string;
  status: RunStatus;
  /** SHA-256 digest of the frozen IR JSON */
  irDigest: string;
  /** SHA-256 digest of the input JSON */
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
  /** Run generation: starts at 1 and increments on each Run-level retry. */
  runAttempt: number;
  /** Evaluated top-level Workflow outputs, persisted when the Run completes. */
  output?: Record<string, unknown>;
  /** Run-level error message, set when the Run fails outside a single leaf output. */
  error?: string;
  /** Lineage to the prior Run this Run was forked from (set on Forked Runs). */
  lineage?: RunLineage;
  /** Effective submit-time Agent Overrides applied before this Run's IR was frozen. */
  agentOverrides?: AgentOverrides;
  /** Non-fatal warnings produced while resolving submit-time metadata. */
  submissionWarnings?: AgentOverrideWarning[];
  /** Hash of the frozen merged hook configuration; absent when no hooks apply. */
  hookConfigHash?: string;
  /** True when this Run was submitted with hooks intentionally disabled. */
  skipHooks?: boolean;
  /** Node states included when inspecting a specific run (GET /runs/:runId) */
  nodes?: NodeExecutionState[];
}

// ─── Expression evaluation context ──────────────────────────────

export interface ExpressionContext {
  input: Record<string, unknown>;
  /** Step outputs keyed by step id */
  steps: Record<string, unknown>;
  /** Frozen Workflow Spec metadata exposed to CEL/template expressions. */
  workflow: WorkflowExpressionContext;
  loop?: { iter: number; last?: unknown };
  item?: unknown;
  item_id?: string;
  item_index?: number;
  run_id: string;
}

export interface WorkflowExpressionContext {
  name: string;
  description: string;
  source_path: string;
  source_dir: string;
}

// ─── Executor adapter contract ──────────────────────────────────

/**
 * Classification of an executor failure. Used by the interpreter to decide
 * whether a node is non-recoverable (→ failed) and whether an agent response
 * failure is retryable (parse/schema).
 */
export type FailureKind = "parse" | "schema" | "spawn" | "timeout" | "killed" | "capture" | "exit" | "config" | "hook_failure";

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
  /** Rendered Program command, surfaced for hook onNodeComplete/Error events. */
  command?: string;
  /** Whether the Program command ran with shell semantics. */
  shell?: boolean;
  /** Effective Program subprocess environment, surfaced for hook events. */
  subprocessEnv?: Record<string, string>;
  /** Failure classification when execution did not succeed. */
  failureKind?: FailureKind;
  /** True if the executor was aborted mid-execution */
  partial?: boolean;
  /** Raw acpx session record ID. Use to locate the original transcript at
   *  ~/.acpx/sessions/<acpxRecordId>.json. Absent when acpx is not used. */
  acpxRecordId?: string;
  /** Absolute working directory passed to acpx via --cwd. Always present;
   *  defaults to process.cwd() when no agent cwd is configured. */
  cwd?: string;
}

export interface AgentContextUsage {
  used: number;
  size: number;
  updatedAt: string;
}

export interface AgentTokenUsage {
  source: "prompt_response";
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export type AgentAttemptTelemetryState = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface AgentIoPreview {
  preview: string;
  truncated: boolean;
  originalBytes: number;
  headBytes: number;
  tailBytes?: number;
  artifactRef?: string;
}

export interface AgentToolCallTelemetry {
  toolCallId: string;
  title?: string;
  status?: string;
  kind?: string;
  toolName?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentToolsTelemetry {
  totalToolCallCount: number;
  droppedToolCallCount: number;
  recentCalls: AgentToolCallTelemetry[];
}

export interface AgentAttemptTelemetry {
  attempt: number;
  state: AgentAttemptTelemetryState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  context?: AgentContextUsage;
  tokenUsage?: AgentTokenUsage;
  input?: AgentIoPreview;
  output?: AgentIoPreview;
  tools: AgentToolsTelemetry;
  /** Raw acpx session record ID. Use to locate the original transcript at
   *  ~/.acpx/sessions/<acpxRecordId>.json. Absent on historical data or when
   *  acpx is not used. */
  acpxRecordId?: string;
  /** Absolute working directory passed to acpx via --cwd. Absent on historical
   *  data; always present in new artifacts. */
  cwd?: string;
}

export interface AgentTelemetry {
  currentAttempt: number;
  attempts: AgentAttemptTelemetry[];
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
  /** Frozen hook runner for this Run; absent disables all hook machinery. */
  hookRunner?: import("./hooks/runner.js").HookRunner;
}

export interface RunOptions {
  /** Resolved input values */
  input: Record<string, unknown>;
  /** Unique run identifier (generated if not provided) */
  runId?: string;
  /** Catalog ref used to start this Run, when applicable. */
  workflowRef?: string;
  /** Absolute Workflow Spec path used to compile this Run. */
  workflowSourcePath?: string;
  /** Effective submit-time Agent Overrides applied before this Run's IR was frozen. */
  agentOverrides?: AgentOverrides;
  /** Non-fatal warnings produced while resolving submit-time metadata. */
  submissionWarnings?: AgentOverrideWarning[];
  /** True when hook loading/freezing/execution is disabled for this new Run. */
  skipHooks?: boolean;
}

// ─── Supervisor types ────────────────────────────────────────────

export interface SupervisorConfig {
  /** Port to listen on (0 = random) */
  port?: number;
  /** Host to bind (default "127.0.0.1") */
  host?: string;
  /** Base directory for .acpus/ state (default cwd) */
  stateDir?: string;
  /** Workspace root for Run execution and source-path validation. */
  workspace?: string;
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
  /** Catalog ref used to start this Run, when applicable. */
  workflowRef?: string;
}

export interface RunSummary {
  runId: string;
  workflowName: string;
  workflowRef?: string;
  workflowSourcePath?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  lineage?: RunLineage;
}

export interface RunCleanItem {
  runId: string;
  status?: RunStatus;
  bytes: number;
  reason?: string;
}

export interface RunCleanResult {
  dryRun: boolean;
  deletedCount: number;
  skippedCount: number;
  bytesReclaimed: number;
  deleted: RunCleanItem[];
  skipped: RunCleanItem[];
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
