import type { AcpusIr, IrNode, NodeKeyTemplate } from "@acpus/core";
import { parseDurationMs, compileWorkflow } from "@acpus/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExpressionContext, InterpreterOptions, NodeKeyDynamic, RunOptions } from "./types.js";
import { RunStore } from "./store.js";
import { ExpressionEvaluator } from "./evaluator.js";
import { resolveNodeKey } from "./keys.js";
import { canTransition, transition, createInitialNodeState, resetFailedForRetry, resetRunningForCrashRecovery } from "./state-machine.js";
import { ArtifactStore } from "./artifacts.js";
import type { ExecutorAdapter } from "./executors/types.js";
import type { NodeExecutionState, NodeState, ReplayResult, ReplayMismatch } from "./types.js";
import { validateInput } from "./validate-input.js";
import { randomUUID } from "node:crypto";
import pLimit from "p-limit";

/**
 * The core IR interpreter that drives state transitions, orchestrates
 * execution, and persists state.
 */
export class WorkflowInterpreter {
  private readonly store: RunStore;
  private readonly evaluator: ExpressionEvaluator;
  private readonly mockAgentExecutor: ExecutorAdapter;
  private readonly acpxAgentExecutor: ExecutorAdapter;
  private readonly programExecutor: ExecutorAdapter;
  private readonly artifactStore: ArtifactStore;
  private readonly maxConcurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Active abort controllers keyed by "runId:nodeKey" for pause/cancel support */
  private readonly abortControllers: Map<string, AbortController> = new Map();

  /** Intent of an in-flight abort keyed by "runId:nodeKey" (pause vs cancel). */
  private readonly abortIntents: Map<string, "paused" | "cancelled"> = new Map();

  /** Absolute paths of subworkflow specs currently on the execution stack (cycle guard). */
  private readonly subworkflowStack: Set<string> = new Set();

  /** Scheduling guards for Run-level pause/cancel, keyed by runId.
   *  Per-runId to prevent leakage across runs sharing the same interpreter. */
  private readonly schedulingPaused = new Map<string, boolean>();
  private readonly schedulingCancelled = new Map<string, boolean>();

  constructor(
    store: RunStore,
    agentExecutor: ExecutorAdapter,
    programExecutor: ExecutorAdapter,
    options?: InterpreterOptions & { acpxAgentExecutor?: ExecutorAdapter }
  ) {
    this.store = store;
    this.evaluator = new ExpressionEvaluator({ nowTimestamp: options?.nowTimestamp });
    // `agentExecutor` handles `type: mock` (in-memory); `acpxAgentExecutor`
    // handles builtin/command via acpx. When no real executor is injected,
    // fall back to the mock for both (keeps unit tests acpx-free).
    this.mockAgentExecutor = agentExecutor;
    this.acpxAgentExecutor = options?.acpxAgentExecutor ?? agentExecutor;
    this.programExecutor = programExecutor;
    this.artifactStore = new ArtifactStore(store.getBaseDir());
    this.maxConcurrency = options?.maxConcurrency ?? 10;
    this.sleep = options?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Start a new workflow run to completion (init + execute). Convenience for
   * callers that want to await the terminal state.
   */
  async start(ir: AcpusIr, opts: RunOptions): Promise<import("./types.js").RunState> {
    const meta = this.initRun(ir, opts);
    return this.runToCompletion(ir, opts, meta.runId);
  }

  /**
   * Initialize a run (freeze IR + input, write running meta) and return the
   * initial running state synchronously, without executing nodes.
   */
  initRun(ir: AcpusIr, opts: RunOptions): import("./types.js").RunState {
    const validatedInput = validateInput(ir.input, opts.input);
    const runId = opts.runId ?? randomUUID();
    return this.store.initRun(runId, ir, validatedInput);
  }

  /**
   * Execute a previously-initialized run to its terminal state.
   */
  async runToCompletion(ir: AcpusIr, opts: RunOptions, runId: string): Promise<import("./types.js").RunState> {
    const meta = this.store.readRunMeta(runId)!;
    try {
      await this.executeNode(ir.root, this.buildContext(opts.input, runId), runId, {});
      meta.status = "completed";
    } catch (error) {
      const rootState = this.store.readNodeState(runId, resolveNodeKey(ir.root.keyTemplate));
      if (rootState?.state === "paused") {
        meta.status = "paused";
      } else if (rootState?.state === "cancelled") {
        meta.status = "cancelled";
      } else {
        meta.status = "failed";
        void error;
      }
    } finally {
      // Clean up per-runId scheduling guards when the run settles,
      // so they don't leak memory across runs.
      this.schedulingPaused.delete(runId);
      this.schedulingCancelled.delete(runId);
    }

    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
    return meta;
  }

  /**
   * Resume a run from persisted state.
   */
  async resume(runId: string): Promise<import("./types.js").RunState> {
    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) {
      throw new Error(`Run ${runId} not found`);
    }

    // Reset any running nodes back to pending (crash recovery)
    this.recoverStaleNodes(runId);

    const meta = this.store.readRunMeta(runId)!;
    meta.status = "running";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);

    try {
      await this.executeNode(ir.root, this.buildContext(input, runId), runId, {});
      meta.status = "completed";
    } catch {
      const rootState = this.store.readNodeState(runId, resolveNodeKey(ir.root.keyTemplate));
      if (rootState?.state === "paused") {
        meta.status = "paused";
      } else if (rootState?.state === "cancelled") {
        meta.status = "cancelled";
      } else {
        meta.status = "failed";
      }
    }

    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
    return meta;
  }

  /**
   * Reset any nodes persisted as `running` back to `pending` (crash recovery).
   * Safe to call when adopting a Run after a supervisor restart: in-memory abort
   * controllers are gone, so a node marked `running` on disk has no live
   * execution and must be re-runnable.
   */
  recoverStaleNodes(runId: string): void {
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        nodeState.state = resetRunningForCrashRecovery(nodeState.state);
        this.store.writeNodeState(runId, nodeState);
      }
    }
  }

  /**
   * Deterministically replay a persisted Run and verify its reconstructed
   * Node topology.
   *
   * Re-walks the frozen IR snapshot (never the mutable YAML), feeding recorded
   * per-node outputs back into the expression context so control-flow decisions
   * (switch branches, loop rounds, fanout lanes) are re-derived. No agents or
   * programs are executed, no disk writes occur, and the walk is pinned to the
   * recorded runId + a frozen clock for self-determinism. The set of node keys
   * the re-walk reaches is compared against what was persisted; per-node
   * terminal-state and output equivalence are out of scope for this milestone.
   */
  replay(runId: string): ReplayResult {
    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) {
      throw new Error(`Run ${runId} not found`);
    }

    // Pin determinism to the run's frozen creation clock. `createdAt` is written
    // once at run init and never mutated (unlike `updatedAt`), so it is a stable
    // deterministic-clock source for re-deriving any now()-dependent values.
    // NOTE: aligning the execution-time clock to this same value (so now()-driven
    // control flow replays identically) is a follow-up; R3 replay verifies node
    // topology (reached key set), which does not depend on wall-clock time.
    const meta = this.store.readRunMeta(runId);
    const evaluator = new ExpressionEvaluator({ nowTimestamp: meta?.createdAt });

    // Persisted (recorded) node states, keyed by node key.
    const recorded = new Map<string, NodeExecutionState>();
    for (const s of this.store.listNodeStates(runId)) recorded.set(s.nodeKey, s);

    // States reached by the deterministic re-walk.
    const reached = new Map<string, NodeState>();
    const ctx = this.buildContext(input, runId);
    this.replayNode(ir.root, ctx, runId, {}, undefined, recorded, reached, evaluator);

    // Compare the set of node keys reached by the re-walk against what was
    // persisted. `reached` carries each node's recorded state for reporting; the
    // effective check is topological (which keys the interpretation reaches),
    // since recorded outputs are replayed rather than recomputed.
    const mismatches: ReplayMismatch[] = [];
    for (const [key, recordedState] of recorded) {
      const actual = reached.get(key);
      if (actual === undefined) {
        mismatches.push({ nodeKey: key, kind: "missing-in-replay", expected: recordedState.state });
      } else if (actual !== recordedState.state) {
        mismatches.push({ nodeKey: key, kind: "state", expected: recordedState.state, actual });
      }
    }
    for (const [key, actual] of reached) {
      if (!recorded.has(key)) {
        mismatches.push({ nodeKey: key, kind: "unexpected-in-replay", actual });
      }
    }

    return { runId, ok: mismatches.length === 0, mismatches };
  }

  /**
   * Read-only re-walk used by {@link replay}. Mirrors the control-flow dispatch
   * of executeNode but never executes leaves: it replays recorded outputs into
   * the context and records the reconstructed node key → state. Concurrent
   * containers (parallel/fanout) descend only into the lanes/branches that were
   * actually recorded (racy joins do not run every branch).
   */
  private replayNode(
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    dynamic: NodeKeyDynamic,
    keyPrefix: string | undefined,
    recorded: Map<string, NodeExecutionState>,
    reached: Map<string, NodeState>,
    evaluator: ExpressionEvaluator
  ): void {
    const resolved = resolveNodeKey(node.keyTemplate, dynamic);
    const nodeKey = keyPrefix ? `${keyPrefix}/${resolved}` : resolved;
    const rec = recorded.get(nodeKey);

    // A node absent from the recording was never reached on the original walk
    // (e.g. an untaken switch branch); skip it so we don't fabricate topology.
    if (!rec) return;
    reached.set(nodeKey, rec.state);

    // Feed the recorded output into the step context so downstream decisions
    // re-derive identically. Leaves contribute their output; containers below
    // populate ctx.steps for their own children as they descend.
    if (rec.output !== undefined) ctx.steps[node.id] = rec.output;

    switch (node.kind) {
      case "pipeline":
        for (const child of node.children ?? []) {
          this.replayNode(child, ctx, runId, dynamic, keyPrefix, recorded, reached, evaluator);
        }
        break;
      case "parallel":
        (node.children ?? []).forEach((child, index) => {
          const branchDynamic: NodeKeyDynamic = { ...dynamic, parallelBranchId: String(index) };
          this.replayNode(child, ctx, runId, branchDynamic, keyPrefix, recorded, reached, evaluator);
        });
        break;
      case "fanout": {
        const overExpr = node.metadata.over as string | undefined;
        const items = overExpr ? evaluator.evaluateOverExpression(overExpr, ctx) : [];
        items.forEach((item, index) => {
          const keyCtx: ExpressionContext = { ...ctx, item, item_index: index };
          const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index, keyCtx, evaluator);
          const itemDynamic: NodeKeyDynamic = { ...dynamic, fanoutItemId: itemId, laneId: String(index) };
          const itemCtx: ExpressionContext = { ...keyCtx, steps: { ...ctx.steps }, item_id: itemId };
          for (const child of node.children ?? []) {
            this.replayNode(child, itemCtx, runId, itemDynamic, keyPrefix, recorded, reached, evaluator);
          }
        });
        break;
      }
      case "switch":
        for (const branch of node.branches ?? []) {
          const taken = !branch.when || Boolean(evaluator.evaluateExpression(branch.when, ctx));
          if (taken) {
            for (const child of branch.children) {
              this.replayNode(child, ctx, runId, dynamic, keyPrefix, recorded, reached, evaluator);
            }
            break;
          }
        }
        break;
      case "loop": {
        const untilExpr = node.metadata.until as string | undefined;
        const maxIterations = (node.metadata.max_iterations as number) ?? 100;
        let lastOutput: unknown;
        for (let iter = 0; iter < maxIterations; iter++) {
          const loopCtx: ExpressionContext = { ...ctx, loop: { iter, last: lastOutput } };
          const loopDynamic: NodeKeyDynamic = { ...dynamic, loopRound: iter };
          if (untilExpr && iter > 0 && evaluator.evaluateExpression(untilExpr, loopCtx)) break;
          // Only descend while this round's children were actually recorded.
          let anyChildReached = false;
          for (const child of node.children ?? []) {
            const before = reached.size;
            this.replayNode(child, loopCtx, runId, loopDynamic, keyPrefix, recorded, reached, evaluator);
            if (reached.size > before) anyChildReached = true;
            const childKey = `${keyPrefix ? `${keyPrefix}/` : ""}${resolveNodeKey(child.keyTemplate, loopDynamic)}`;
            lastOutput = recorded.get(childKey)?.output ?? lastOutput;
          }
          if (!anyChildReached) break;
        }
        break;
      }
      case "subworkflow":
        // The child root was executed under this node's key as prefix; descend
        // using recorded child node states (frozen child IR is not re-read).
        for (const [key, state] of recorded) {
          if (key.startsWith(`${nodeKey}/`) && !reached.has(key)) {
            reached.set(key, state.state);
          }
        }
        break;
      // run.agent / run.program / approval are leaves: their recorded state was
      // already captured above; nothing further to descend.
      default:
        break;
    }
  }

  /**
   * Pause a running node.
   */
  pauseNode(runId: string, nodeKey: string): void {
    this.abortIntents.set(`${runId}:${nodeKey}`, "paused");
    const controller = this.abortControllers.get(`${runId}:${nodeKey}`);
    if (controller) {
      controller.abort();
    }

    const state = this.store.readNodeState(runId, nodeKey);
    if (state && canTransition(state.state, "paused")) {
      state.state = transition(state.state, "paused") as NodeState;
      this.store.writeNodeState(runId, state);
    }
  }

  /**
   * Resume a paused node.
   */
  async resumeNode(runId: string, nodeKey: string): Promise<void> {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) {
      throw new Error(`Node ${nodeKey} not found in run ${runId}`);
    }

    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) {
      throw new Error(`Cannot resume node ${nodeKey}: run ${runId} has no persisted IR or input`);
    }

    // Resolve the node IR *before* mutating state. Subworkflow child IR is
    // compiled on demand and never persisted, so a child key like
    // `workflow/sub/child` is unresolvable here; reject explicitly rather than
    // silently no-op and leave the node stuck in a running/pending state.
    const node = this.findNodeByKey(ir.root, nodeKey);
    if (!node) {
      throw new Error(
        `Cannot resume node ${nodeKey}: its definition was not found in the run's IR (subworkflow child nodes are not individually resumable)`
      );
    }

    state.state = transition(state.state, "running") as NodeState;
    this.store.writeNodeState(runId, state);

    const ctx = this.buildContext(input, runId);
    this.populateStepOutputs(runId, ctx);
    // Restore the parent dynamic value-context (fanout item / loop round)
    // captured at first execution so command/prompt re-rendering sees item/loop.
    this.restoreDynamicContext(ctx, state.dynamicContext);
    // Resume re-enters the node as a continuation (continuation prompt for
    // agents), preserving the original full node key for stable identity.
    // `attempt` is incremented by executeNode (single source of truth).
    await this.executeNode(node, ctx, runId, {}, undefined, true, nodeKey);
  }

  /**
   * Cancel a node.
   */
  cancelNode(runId: string, nodeKey: string): void {
    this.abortIntents.set(`${runId}:${nodeKey}`, "cancelled");
    const controller = this.abortControllers.get(`${runId}:${nodeKey}`);
    if (controller) {
      controller.abort();
    }

    const state = this.store.readNodeState(runId, nodeKey);
    if (state && canTransition(state.state, "cancelled")) {
      state.state = transition(state.state, "cancelled") as NodeState;
      this.store.writeNodeState(runId, state);
    }
  }

  /** Resolve the operator intent for an in-flight abort; defaults to paused. */
  private abortIntent(runId: string, nodeKey: string): "paused" | "cancelled" {
    return this.abortIntents.get(`${runId}:${nodeKey}`) ?? "paused";
  }

  /**
   * Retry a failed node.
   *
   * Only a `failed` Node is retryable. A `paused` Node must be resumed (not
   * retried) and `completed`/`cancelled` are terminal — those are rejected with
   * a clear message rather than an opaque illegal-transition error.
   */
  async retryNode(runId: string, nodeKey: string): Promise<void> {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) {
      throw new Error(`Node ${nodeKey} not found in run ${runId}`);
    }
    if (state.state !== "failed") {
      throw new Error(
        `Cannot retry node ${nodeKey} in state '${state.state}': only failed nodes are retryable (use resume for paused nodes)`
      );
    }

    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) {
      throw new Error(`Cannot retry node ${nodeKey}: run ${runId} has no persisted IR or input`);
    }

    // Resolve the node IR *before* mutating state. Subworkflow child IR is
    // compiled on demand and never persisted, so a child key like
    // `workflow/sub/child` is unresolvable here; reject explicitly rather than
    // silently no-op and leave the node stuck in a pending state.
    const node = this.findNodeByKey(ir.root, nodeKey);
    if (!node) {
      throw new Error(
        `Cannot retry node ${nodeKey}: its definition was not found in the run's IR (subworkflow child nodes are not individually retryable)`
      );
    }

    // Control-plane reset (failed → pending), not a business-lifecycle
    // transition. `attempt` is incremented by executeNode.
    state.state = resetFailedForRetry(state.state);
    state.error = undefined;
    this.store.writeNodeState(runId, state);

    const ctx = this.buildContext(input, runId);
    this.populateStepOutputs(runId, ctx);
    // Restore the parent dynamic value-context captured at first execution.
    this.restoreDynamicContext(ctx, state.dynamicContext);
    // Retry re-runs the Activity as a continuation: for agents this resumes
    // the same acpx session (recovering a dead subprocess) via the fixed
    // continuation prompt rather than replaying the original turn. The
    // original full node key is preserved for stable identity.
    await this.executeNode(node, ctx, runId, {}, undefined, true, nodeKey);
  }

  // ─── Run-level controls ─────────────────────────────────────────

  /**
   * Pause an entire Run. Validates Run is `running`, sets scheduling guard,
   * pauses all running nodes, and updates Run metadata to `paused`.
   */
  pauseRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "running") {
      throw new Error(`Cannot pause a run in state '${meta.status}'`);
    }

    this.schedulingPaused.set(runId, true);

    // Pause all currently running nodes
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        this.pauseNode(runId, nodeState.nodeKey);
      }
    }

    meta.status = "paused";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  /**
   * Cancel an entire Run. Validates Run is `running` or `paused`, sets
   * scheduling guard, cancels running nodes, marks pending nodes as cancelled,
   * and updates Run metadata to `cancelled`.
   */
  cancelRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "running" && meta.status !== "paused") {
      throw new Error(`Cannot cancel a run in state '${meta.status}'`);
    }

    this.schedulingCancelled.set(runId, true);

    // Override any prior pause abort intents to "cancelled" so that
    // runToCompletion's catch block writes "cancelled" (not "paused").
    for (const [key, intent] of this.abortIntents) {
      if (key.startsWith(`${runId}:`) && intent === "paused") {
        this.abortIntents.set(key, "cancelled");
      }
    }

    // Cancel all currently running nodes
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        this.cancelNode(runId, nodeState.nodeKey);
      }
    }

    // Also transition paused nodes to cancelled (a prior pauseRun may have
    // left nodes in "paused" state; cancel supersedes pause).
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "paused") {
        if (canTransition(nodeState.state, "cancelled")) {
          nodeState.state = transition(nodeState.state, "cancelled") as NodeState;
          this.store.writeNodeState(runId, nodeState);
        }
      }
    }

    // Mark all pending nodes as cancelled (do NOT materialize unvisited nodes)
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "pending") {
        if (canTransition(nodeState.state, "cancelled")) {
          nodeState.state = transition(nodeState.state, "cancelled") as NodeState;
          this.store.writeNodeState(runId, nodeState);
        }
      }
    }

    meta.status = "cancelled";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  /**
   * Resume an entire paused Run. Validates Run is `paused`, clears scheduling
   * guards, recovers stale nodes, and re-executes from root.
   */
  async resumeRun(runId: string): Promise<void> {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "paused") {
      throw new Error(`Cannot resume a run in state '${meta.status}'`);
    }

    // Clear scheduling guards for this run
    this.schedulingPaused.delete(runId);
    this.schedulingCancelled.delete(runId);

    // Recover stale running nodes back to pending
    this.recoverStaleNodes(runId);

    // Also reset paused nodes back to pending so runToCompletion can re-execute them.
    // Without this, executeNode sees the 'paused' state and throws NodeAbortedError,
    // making the run permanently stuck.
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "paused") {
        nodeState.state = "pending";
        this.store.writeNodeState(runId, nodeState);
      }
    }

    meta.status = "running";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  /**
   * Retry a failed Run. Validates Run is `failed`, resets failed materialized
   * nodes to pending (preserving completed), clears scheduling guards, and
   * re-executes from root. Same Run ID, no new Run.
   */
  retryRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "failed") {
      throw new Error(`Cannot retry a run in state '${meta.status}'`);
    }

    // Clear scheduling guards for this run
    this.schedulingPaused.delete(runId);
    this.schedulingCancelled.delete(runId);

    // Reset failed and paused materialized nodes to pending (preserve completed).
    // Paused nodes can exist in a "failed" run if it was paused before a sibling
    // failed (e.g. parallel lane failure while another lane was paused).
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "failed") {
        nodeState.state = resetFailedForRetry(nodeState.state);
        nodeState.error = undefined;
        this.store.writeNodeState(runId, nodeState);
      } else if (nodeState.state === "paused") {
        nodeState.state = "pending";
        this.store.writeNodeState(runId, nodeState);
      }
    }

    meta.status = "running";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  // ─── Node execution dispatch ──────────────────────────────────

  private async executeNode(
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    dynamic: NodeKeyDynamic,
    keyPrefix?: string,
    resume?: boolean,
    overrideNodeKey?: string
  ): Promise<unknown> {
    // On resume/retry the full resolved node key is supplied directly so the
    // node's stable identity (and thus the agent's acpx session name) survives
    // across loop/fanout/lane/subworkflow dynamics that are not re-derived here.
    const resolved = resolveNodeKey(node.keyTemplate, dynamic);
    const nodeKey = overrideNodeKey ?? (keyPrefix ? `${keyPrefix}/${resolved}` : resolved);

    // Check if already completed (from prior run)
    const existing = this.store.readNodeState(runId, nodeKey);
    if (existing?.state === "completed") {
      ctx.steps[node.id] = existing.output;
      return existing.output;
    }
    if (existing?.state === "cancelled" || existing?.state === "paused") {
      throw new NodeAbortedError(nodeKey, existing.state);
    }

    // Initialize state
    const state = existing ?? createInitialNodeState(nodeKey, node.id, node.kind);
    if (state.state === "failed") {
      throw new Error(`Node ${nodeKey} is in failed state`);
    }

    // Run-level scheduling guards: if this Run is paused or cancelled,
    // don't schedule new work.
    if (this.schedulingPaused.get(runId) && state.state === "pending") {
      throw new NodeAbortedError(nodeKey, "paused");
    }
    if (this.schedulingCancelled.get(runId) && state.state === "pending") {
      if (canTransition(state.state, "cancelled")) {
        state.state = transition(state.state, "cancelled") as NodeState;
        this.store.writeNodeState(runId, state);
      }
      throw new NodeAbortedError(nodeKey, "cancelled");
    }

    // Set up abort controller
    const controller = new AbortController();
    this.abortControllers.set(`${runId}:${nodeKey}`, controller);

    // Transition to running
    if (canTransition(state.state, "running")) {
      state.state = transition(state.state, "running") as NodeState;
    }
    state.attempt++;
    state.startedAt = new Date().toISOString();
    // Snapshot the parent dynamic value-context (fanout item / loop round) for
    // executable leaves so resume/retry can re-render their command/prompt
    // without the parent re-deriving item/loop. Only captured on first run
    // (not on resume/retry, which restore it from disk into ctx).
    if (!resume && (node.kind === "run.agent" || node.kind === "run.program")) {
      const snapshot = this.captureDynamicContext(ctx);
      if (snapshot) state.dynamicContext = snapshot;
    }
    this.store.writeNodeState(runId, state);

    try {
      let output: unknown;
      // Artifact refs produced by a leaf execution in this call frame. Kept as a
      // local (not a shared field) so concurrent parallel/fanout siblings can't
      // clobber each other's refs.
      let artifactRefs: string[] | undefined;

      switch (node.kind) {
        case "pipeline":
          output = await this.executePipeline(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "run.agent": {
          const leaf = await this.executeAgent(node, ctx, runId, controller.signal, nodeKey, resume);
          output = leaf.output;
          artifactRefs = leaf.artifactRefs;
          break;
        }
        case "run.program": {
          const leaf = await this.executeProgram(node, ctx, runId, controller.signal, nodeKey);
          output = leaf.output;
          artifactRefs = leaf.artifactRefs;
          break;
        }
        case "parallel":
          output = await this.executeParallel(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "fanout":
          output = await this.executeFanout(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "switch":
          output = await this.executeSwitch(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "loop":
          output = await this.executeLoop(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "approval":
          output = await this.executeApproval(node, ctx, runId, controller.signal, nodeKey);
          break;
        case "subworkflow":
          output = await this.executeSubworkflow(node, ctx, runId, dynamic, nodeKey);
          break;
        default:
          throw new Error(`Unknown node kind: ${node.kind}`);
      }

      // Transition to completed
      state.state = "completed";
      state.output = output;
      if (artifactRefs) state.artifactRefs = artifactRefs;
      state.completedAt = new Date().toISOString();
      this.store.writeNodeState(runId, state);

      // Add output to step context
      ctx.steps[node.id] = output;

      return output;
    } catch (error) {
      if (error instanceof NodeAbortedError) {
        // Transition this node to the same state as the child that was aborted.
        state.state = error.state === "paused" ? "paused" : "cancelled";
        state.error = `Aborted: ${error.state}`;
        // Preserve any output + partial transcript artifacts from the aborted leaf.
        if (error.output !== undefined) state.output = error.output;
        if (error.artifactRefs) state.artifactRefs = error.artifactRefs;
        this.store.writeNodeState(runId, state);
        throw error;
      }

      state.state = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      // Preserve artifacts a leaf wrote before failing (e.g. program stdout/stderr).
      if (error instanceof LeafExecutionError && error.artifactRefs) state.artifactRefs = error.artifactRefs;
      state.completedAt = new Date().toISOString();
      this.store.writeNodeState(runId, state);
      throw error;
    } finally {
      this.abortControllers.delete(`${runId}:${nodeKey}`);
      this.abortIntents.delete(`${runId}:${nodeKey}`);
    }
  }

  // ─── Kind-specific execution ───────────────────────────────────

  private async executePipeline(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const children = node.children ?? [];
    for (const child of children) {
      await this.executeNode(child, ctx, runId, dynamic, keyPrefix);
    }
    // Pipeline output: map of step outputs
    return { ...ctx.steps };
  }

  private async executeAgent(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string, resume?: boolean): Promise<LeafResult> {
    const retry = node.metadata.retry as { max?: number; backoff?: string } | undefined;
    const maxRetries = typeof retry?.max === "number" ? retry.max : 0;
    const backoffMs = retry?.backoff ? parseDurationMs(retry.backoff) : 0;

    // Route to the in-memory mock executor or the real acpx-backed executor.
    const agent = node.metadata.agent as { type?: string } | undefined;
    const executor = agent?.type === "mock" ? this.mockAgentExecutor : this.acpxAgentExecutor;

    for (let attempt = 0; ; attempt++) {
      const result = await executor.execute({ node, context: ctx, signal, nodeKey, resume, retry: attempt > 0 });

      // Always persist the transcript (and stderr) as artifacts when the
      // executor produced raw output (acpx NDJSON). Mock executors return no
      // stdout, so nothing is written for them. Refs flow back to executeNode
      // via the return value / thrown error (no shared mutable field).
      const artifactRefs = (result.stdout !== undefined || result.stderr !== undefined)
        ? this.writeAgentArtifacts(runId, nodeKey, result.stdout ?? "", result.stderr ?? "")
        : result.artifactRefs;

      if (result.partial) {
        // Operator abort → carry output + transcript refs on the abort error;
        // executeNode persists the paused/cancelled state.
        throw new NodeAbortedError(nodeKey, this.abortIntent(runId, nodeKey), artifactRefs, result.output);
      }

      // parse/schema failures are retryable while attempts remain.
      const retryable = result.failureKind === "parse" || result.failureKind === "schema";
      if (retryable && attempt < maxRetries) {
        const state = this.store.readNodeState(runId, nodeKey);
        if (state) {
          state.attempt++;
          this.store.writeNodeState(runId, state);
        }
        if (backoffMs > 0) await this.sleep(backoffMs);
        continue;
      }

      if (result.failureKind || (result.error && !result.partial)) {
        const use = (node.metadata.agent as { use?: string } | undefined)?.use ?? "?";
        throw new LeafExecutionError(`Agent step '${node.id}' (use: ${use}) failed${result.failureKind ? ` (${result.failureKind})` : ""}: ${result.error ?? "unknown"}`, artifactRefs);
      }

      // Agent output is wrapped in an envelope for parity with program steps.
      return { output: { output: result.output }, artifactRefs };
    }
  }

  private async executeProgram(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<LeafResult> {
    const result = await this.programExecutor.execute({ node, context: ctx, signal, nodeKey });

    // Operator abort → paused/cancelled (carry output on the abort error).
    if (result.partial) {
      throw new NodeAbortedError(nodeKey, this.abortIntent(runId, nodeKey), undefined, result.output);
    }

    // Always persist stdout/stderr as artifacts (even when empty). An artifact
    // write failure is itself non-recoverable.
    const artifactRefs = this.writeProgramArtifacts(runId, nodeKey, result.stdout ?? "", result.stderr ?? "");

    // Non-recoverable failures fail the node.
    if (result.failureKind) {
      throw new LeafExecutionError(`Program step '${node.id}' failed (${result.failureKind}): ${result.error ?? "unknown"}`, artifactRefs);
    }

    // A non-zero exit code is step data. Expose output + exit_code envelope.
    return { output: { output: result.output, exit_code: result.exitCode ?? 0 }, artifactRefs };
  }

  /** Write stdout.log/stderr.log artifacts; returns their URIs. */
  private writeProgramArtifacts(runId: string, nodeKey: string, stdout: string, stderr: string): string[] {
    const out = this.artifactStore.write(runId, nodeKey, "stdout.log", stdout);
    const err = this.artifactStore.write(runId, nodeKey, "stderr.log", stderr);
    return [out.uri, err.uri];
  }

  /** Write the agent transcript (ACP NDJSON) and stderr as artifacts; returns their URIs. */
  private writeAgentArtifacts(runId: string, nodeKey: string, transcript: string, stderr: string): string[] {
    const out = this.artifactStore.write(runId, nodeKey, "transcript.jsonl", transcript);
    const err = this.artifactStore.write(runId, nodeKey, "stderr.log", stderr);
    return [out.uri, err.uri];
  }

  private async executeParallel(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const children = node.children ?? [];
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;
    const join = (node.metadata.join as string) ?? "all";

    const limit = pLimit(maxConcurrency);
    // Each branch resolves to { child, output } so race can identify the winner.
    const branchPromises = children.map((child, index) =>
      limit(async () => {
        const branchDynamic: NodeKeyDynamic = { ...dynamic, parallelBranchId: String(index) };
        const output = await this.executeNode(child, { ...ctx, steps: { ...ctx.steps } }, runId, branchDynamic, keyPrefix);
        return { child, output };
      })
    );

    if (join === "race") {
      // First branch to settle wins; losers are not cancelled but silently
      // consumed so their later rejection doesn't surface as unhandled.
      const winner = await Promise.race(branchPromises);
      branchPromises.forEach((p) => void p.catch(() => undefined));
      const mapOutput: Record<string, unknown> = { [winner.child.id]: winner.output };
      ctx.steps[winner.child.id] = winner.output;
      return mapOutput;
    }

    // join: all — collect every branch output keyed by step id.
    const results = await Promise.all(branchPromises);
    const mapOutput: Record<string, unknown> = {};
    for (const { child, output } of results) {
      mapOutput[child.id] = output;
      ctx.steps[child.id] = output;
    }
    return mapOutput;
  }

  private async executeFanout(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const overExpr = node.metadata.over as string;
    if (!overExpr) {
      throw new Error(`fanout node ${node.id} missing 'over' expression`);
    }

    const items = this.evaluator.evaluateOverExpression(overExpr, ctx);
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;
    const join = (node.metadata.join as string) ?? "all";
    const quorum = node.metadata.quorum as number | undefined;
    const successCriteria = node.metadata.success_criteria as { min_success?: number } | undefined;
    const children = node.children ?? [];

    const limit = pLimit(maxConcurrency);

    // Each lane resolves to a LaneResult. A normal failure is captured (does
    // not reject) so the join/min_success logic can run. A NodeAbortedError
    // (operator pause/cancel) re-throws so it propagates to the parent.
    const lanePromises = items.map((item, index) =>
      limit(async (): Promise<LaneResult> => {
        const keyCtx: ExpressionContext = { ...ctx, item, item_index: index };
        const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index, keyCtx, this.evaluator);
        const itemDynamic: NodeKeyDynamic = { ...dynamic, fanoutItemId: itemId, laneId: String(index) };
        const itemCtx: ExpressionContext = {
          ...keyCtx,
          steps: { ...ctx.steps },
          item_id: itemId
        };
        try {
          let laneOutput: unknown;
          for (const child of children) {
            laneOutput = await this.executeNode(child, itemCtx, runId, itemDynamic, keyPrefix);
          }
          return { ok: true, output: laneOutput };
        } catch (error) {
          if (error instanceof NodeAbortedError) throw error;
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );

    // Wait strategy.
    const settled = await this.waitForFanout(lanePromises, join, quorum);

    // Success criteria. Default min_success follows the join strategy.
    const defaultMinSuccess = join === "race" ? 1 : join === "quorum" ? (quorum ?? 1) : items.length;
    const minSuccess = successCriteria?.min_success ?? defaultMinSuccess;

    const successes = settled.filter((r): r is { ok: true; output: unknown } => r.ok);
    if (successes.length < minSuccess) {
      throw new Error(`fanout ${node.id}: ${successes.length} successful lanes, requires ${minSuccess}`);
    }

    // outputMerge: "array" of successful lane outputs.
    return successes.map((r) => r.output);
  }

  /**
   * Resolve fanout lanes per the wait strategy. Lanes never reject on normal
   * failure (captured as LaneResult); only NodeAbortedError rejects, which we
   * let propagate. Losing/excess lanes are silently consumed.
   */
  private async waitForFanout(lanePromises: Promise<LaneResult>[], join: string, quorum?: number): Promise<LaneResult[]> {
    if (join === "race") {
      const first = await Promise.race(lanePromises);
      lanePromises.forEach((p) => void p.catch(() => undefined));
      return [first];
    }

    if (join === "quorum") {
      const target = Math.min(quorum ?? lanePromises.length, lanePromises.length);
      return new Promise<LaneResult[]>((resolve, reject) => {
        const collected: LaneResult[] = [];
        for (const p of lanePromises) {
          p.then(
            (r) => {
              collected.push(r);
              if (collected.length >= target) resolve(collected.slice());
            },
            (err) => reject(err)
          );
        }
      });
    }

    // join: all — wait for every lane.
    return Promise.all(lanePromises);
  }

  private async executeSwitch(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const branches = node.branches ?? [];

    for (const branch of branches) {
      if (branch.when) {
        const matches = this.evaluator.evaluateExpression(branch.when, ctx);
        if (matches) {
          let lastOutput: unknown;
          for (const child of branch.children) {
            lastOutput = await this.executeNode(child, ctx, runId, dynamic, keyPrefix);
          }
          return lastOutput;
        }
      } else {
        // Default branch (no when condition)
        let lastOutput: unknown;
        for (const child of branch.children) {
          lastOutput = await this.executeNode(child, ctx, runId, dynamic, keyPrefix);
        }
        return lastOutput;
      }
    }

    throw new Error(`Switch node ${node.id}: no branch matched and no default`);
  }

  private async executeLoop(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const untilExpr = node.metadata.until as string;
    const maxIterations = (node.metadata.max_iterations as number) ?? 100;
    const children = node.children ?? [];

    let lastOutput: unknown;
    for (let iter = 0; iter < maxIterations; iter++) {
      const loopCtx: ExpressionContext = {
        ...ctx,
        loop: { iter, last: lastOutput }
      };
      const loopDynamic: NodeKeyDynamic = { ...dynamic, loopRound: iter };

      // Check until condition (skip on first iteration)
      if (untilExpr && iter > 0) {
        const done = this.evaluator.evaluateExpression(untilExpr, loopCtx);
        if (done) break;
      }

      // Execute loop body
      for (const child of children) {
        lastOutput = await this.executeNode(child, loopCtx, runId, loopDynamic, keyPrefix);
      }
    }

    // outputMerge: "last"
    return lastOutput;
  }

  private async executeApproval(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<unknown> {
    const timeout = node.metadata.timeout as string | undefined;
    const onTimeout = node.metadata.on_timeout as string | undefined;
    const at = this.evaluator.getNow();

    const timeoutMs = timeout ? parseDurationMs(timeout) : undefined;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(new NodeAbortedError(nodeKey, "paused"));
      };

      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup();
            // On timeout, the resolved decision follows the configured policy.
            // `approve`/`reject` resolve; `fail`/`escalate` fail the node
            // (escalate has no runtime channel yet — see R3).
            if (onTimeout === "approve") {
              resolve({ approved: true, decision: "timeout", at });
            } else if (onTimeout === "reject") {
              resolve({ approved: false, decision: "timeout", at });
            } else {
              reject(new Error(`Approval timed out after ${timeout} (on_timeout: ${onTimeout ?? "fail"})`));
            }
          }, timeoutMs)
        : undefined;

      signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };

      // For now, auto-approve in non-supervisor mode after a short delay
      if (!timeoutMs) {
        setTimeout(() => {
          cleanup();
          resolve({ approved: true, decision: "approved", at });
        }, 100);
      }
    });
  }

  private async executeSubworkflow(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, nodeKey: string): Promise<unknown> {
    const specPath = node.metadata.subworkflow as string;
    const inputSpec = node.metadata.input as Record<string, unknown> | undefined;

    // Resolve the child spec path relative to the parent spec, falling back to cwd.
    const parentIr = this.store.readIr(runId);
    const baseDir = parentIr?.source.path ? dirname(parentIr.source.path) : process.cwd();
    const childAbs = resolve(baseDir, specPath);

    // Cycle guard across nested subworkflows.
    if (this.subworkflowStack.has(childAbs)) {
      throw new Error(`Subworkflow cycle detected for '${childAbs}'`);
    }

    // Compile the child spec at runtime (file I/O lives in the runtime layer).
    const source = readFileSync(childAbs, "utf8");
    const compiled = compileWorkflow(source, {
      sourcePath: childAbs,
      includeResolver: (includePath, fromPath) => {
        const dir = fromPath ? dirname(resolve(fromPath)) : process.cwd();
        return readFileSync(resolve(dir, includePath), "utf8");
      }
    });
    if (!compiled.ok || !compiled.ir) {
      throw new Error(`Subworkflow '${specPath}' failed to compile: ${compiled.diagnostics.map((d) => d.message).join(", ")}`);
    }

    // Evaluate the declared input map against the current context. A field that
    // is a single ${{ }} expression keeps its native type; otherwise it is a
    // template string.
    const childInput: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputSpec ?? {})) {
      childInput[key] = this.evaluateInputValue(value, ctx);
    }

    // Validate subworkflow input against the child IR's compiled input schema.
    const validatedChildInput = validateInput(compiled.ir.input, childInput);

    // Execute the child root as a nested pipeline. Child node keys are nested
    // under this subworkflow's node key to stay unique within the run.
    this.subworkflowStack.add(childAbs);
    try {
      const childCtx = this.buildContext(validatedChildInput, runId);
      await this.executeNode(compiled.ir.root, childCtx, runId, dynamic, nodeKey);
      return { ...childCtx.steps };
    } finally {
      this.subworkflowStack.delete(childAbs);
    }
  }

  /** Evaluate a subworkflow input value, preserving native type for single expressions. */
  private evaluateInputValue(value: unknown, ctx: ExpressionContext): unknown {
    if (typeof value !== "string") return value;
    const single = value.match(/^\s*\$\{\{(.+)\}\}\s*$/s);
    if (single) {
      return this.evaluator.evaluateExpression(single[1]!.trim(), ctx);
    }
    return this.evaluator.evaluateTemplate(value, ctx);
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private buildContext(input: Record<string, unknown>, runId: string): ExpressionContext {
    return { input, steps: {}, run_id: runId };
  }

  private populateStepOutputs(runId: string, ctx: ExpressionContext): void {
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "completed" && nodeState.output !== undefined) {
        ctx.steps[nodeState.nodeId] = nodeState.output;
      }
    }
  }

  /** Extract the parent dynamic value-context (fanout item / loop round) from a context, if any. */
  private captureDynamicContext(ctx: ExpressionContext): import("./types.js").NodeDynamicContext | undefined {
    const snapshot: import("./types.js").NodeDynamicContext = {};
    let has = false;
    if (ctx.item !== undefined) { snapshot.item = ctx.item; has = true; }
    if (ctx.item_id !== undefined) { snapshot.item_id = ctx.item_id; has = true; }
    if (ctx.item_index !== undefined) { snapshot.item_index = ctx.item_index; has = true; }
    if (ctx.loop !== undefined) { snapshot.loop = ctx.loop; has = true; }
    return has ? snapshot : undefined;
  }

  /** Merge a persisted dynamic value-context back into a rebuilt context (resume/retry). */
  private restoreDynamicContext(ctx: ExpressionContext, snapshot: import("./types.js").NodeDynamicContext | undefined): void {
    if (!snapshot) return;
    if (snapshot.item !== undefined) ctx.item = snapshot.item;
    if (snapshot.item_id !== undefined) ctx.item_id = snapshot.item_id;
    if (snapshot.item_index !== undefined) ctx.item_index = snapshot.item_index;
    if (snapshot.loop !== undefined) ctx.loop = snapshot.loop;
  }

  private findNodeByKey(root: IrNode, nodeKey: string): IrNode | undefined {
    // Node keys contain dynamic dimensions (e.g. "workflow/mapped/item:0/lane:0")
    // but IR nodes have template keys without dynamics. Match by extracting
    // the nodePath from the resolved key and comparing to the template.
    // The nodePath is always the prefix before any dynamic segments.
    // We match by the IR node's id since that's unique and stable.
    const nodeId = this.extractNodeIdFromKey(nodeKey);
    return this.findNodeById(root, nodeId);
  }

  /** Extract the step ID from a resolved node key. The ID is the last path segment before dynamic dims. */
  private extractNodeIdFromKey(nodeKey: string): string {
    // Key format: "workflow/step-a" or "workflow/mapped/item:0/lane:0"
    // The node id is the second segment (after "workflow/") for top-level steps
    // For nested, it's the segment before any "type:value" segments
    const segments = nodeKey.split("/");
    // Find the last segment that is NOT a "type:value" dynamic segment
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!segments[i]!.includes(":")) {
        return segments[i]!;
      }
    }
    return segments[segments.length - 1]!;
  }

  private findNodeById(root: IrNode, nodeId: string): IrNode | undefined {
    if (root.id === nodeId) return root;

    for (const child of root.children ?? []) {
      const found = this.findNodeById(child, nodeId);
      if (found) return found;
    }

    for (const branch of root.branches ?? []) {
      for (const child of branch.children) {
        const found = this.findNodeById(child, nodeId);
        if (found) return found;
      }
    }

    return undefined;
  }

  private extractItemId(item: unknown, keyExpr: string | undefined, index: number | undefined, ctx: ExpressionContext, evaluator: ExpressionEvaluator): string {
    if (keyExpr) {
      const result = evaluator.evaluateTemplate(keyExpr, ctx);
      if (result) return result;
    }
    return String(index ?? 0);
  }
}

/** Result of a single fanout lane: success carries the output, failure the message. */
type LaneResult = { ok: true; output: unknown } | { ok: false; error: string };

/** Output + artifact references produced by a leaf (agent/program) execution. */
interface LeafResult {
  output: unknown;
  artifactRefs?: string[];
}

class NodeAbortedError extends Error {
  constructor(
    public readonly nodeKey: string,
    public readonly state: "paused" | "cancelled",
    /** Artifact refs (e.g. partial transcript) to persist on the aborted node. */
    public readonly artifactRefs?: string[],
    /** Partial output captured before the abort. */
    public readonly output?: unknown
  ) {
    super(`Node ${nodeKey} aborted: ${state}`);
    this.name = "NodeAbortedError";
  }
}

/** A non-recoverable leaf failure that still carries artifacts written before failing. */
class LeafExecutionError extends Error {
  constructor(
    message: string,
    public readonly artifactRefs?: string[]
  ) {
    super(message);
    this.name = "LeafExecutionError";
  }
}
