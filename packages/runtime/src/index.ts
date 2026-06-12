// ─── Types ────────────────────────────────────────────────────────
export type {
  NodeState,
  RunStatus,
  NodeKeyDynamic,
  NodeExecutionState,
  RunState,
  RunLineage,
  RunCheckpoint,
  ExpressionContext,
  ExecutorResult,
  ArtifactRef,
  InterpreterOptions,
  RunOptions,
  SupervisorConfig,
  SupervisorMetadata,
  SupervisorHealth,
  StartRunRequest,
  RunSummary,
  RunCleanItem,
  RunCleanResult,
  ReplayResult,
  ReplayMismatch,
  NodeDynamicContext
} from "./types.js";

// ─── Executor contract ───────────────────────────────────────────
export type { ExecutorAdapter, ExecutionRequest } from "./executors/types.js";

// ─── Keys ────────────────────────────────────────────────────────
export {
  resolveNodeKey,
  parseNodeKey,
  staticNodePathFromKey,
  isNodeKeyAtOrBelow,
  isNodeKeyInDynamicScope,
  isNodeKeyBelowAnyAnchor,
  withNodeKeyPrefix,
  encodeNodeKeyForFs,
  encodeNodeKeyForDir
} from "./keys.js";
export type { ParsedNodeKey } from "./keys.js";

// ─── Evaluator ───────────────────────────────────────────────────
export { ExpressionEvaluator } from "./evaluator.js";

// ─── Store ───────────────────────────────────────────────────────
export { RunStore } from "./store.js";

// ─── State Machine ───────────────────────────────────────────────
export { canTransition, transition, isTerminal, createInitialNodeState, resetFailedForRetry, resetRunningForCrashRecovery, resetAwaitingForCrashRecovery } from "./state-machine.js";

// ─── Artifacts ───────────────────────────────────────────────────
export { ArtifactStore, ArtifactReferences } from "./artifacts.js";
export type { ParsedArtifactReference } from "./artifacts.js";

// ─── Interpreter ─────────────────────────────────────────────────
export { WorkflowInterpreter } from "./interpreter.js";

// ─── Input Validation ────────────────────────────────────────────
export { InputValidationFailure, validateInput } from "./validate-input.js";
export type { InputValidationError } from "./types.js";

// ─── Executors ───────────────────────────────────────────────────
export { MockProgramExecutor } from "./executors/mock-program.js";
export { ProgramExecutor } from "./executors/program.js";
export { AgentExecutor } from "./executors/agent.js";

// ─── Supervisor ──────────────────────────────────────────────────
export { createSupervisorApp } from "./supervisor-app.js";
export { startRunSupervisor } from "./supervisor-runner.js";
export { ensureWorkspaceSupervisor } from "./supervisor-discovery.js";

// ─── Client ──────────────────────────────────────────────────────
export { RunSupervisorClient, ForkRejectedError } from "./client.js";

// ─── Fork ────────────────────────────────────────────────────────
export { planFork, applyFork, materializeFork, ForkError } from "./fork.js";
export type { ForkPlan, BoundaryReason, MaterializeForkOptions, MaterializedFork } from "./fork.js";
