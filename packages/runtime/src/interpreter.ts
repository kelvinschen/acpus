import type { AcpusIr, IrNode, NodeKeyTemplate } from "@acpus/core";
import { parseDurationMs, compileWorkflow, hashIrNode, realPathOrUndefined } from "@acpus/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentAttemptTelemetry, AgentAttemptTelemetryState, ExpressionContext, InterpreterOptions, NodeKeyDynamic, RunOptions } from "./types.js";
import { RunStore } from "./store.js";
import { ExpressionEvaluator } from "./evaluator.js";
import {
  appendDynamicFrame,
  appendDynamicFrames,
  nestedParallelBranchDynamic,
  resolveNodeKey,
  staticNodePathFromKey,
  withNodeKeyPrefix
} from "./keys.js";
import { canTransition, transition, createInitialNodeState } from "./state-machine.js";
import { ArtifactStore } from "./artifacts.js";
import { AttemptArtifactRecorder } from "./attempt-artifacts.js";
import type { AgentExecutionRequest, ExecutorAdapter, ProgramExecutionRequest } from "./executors/types.js";
import { renderAgentRequestPrompt, renderAgentSessionKey } from "./executors/agent.js";
import type { NodeExecutionState, NodeState, ReplayResult, ReplayMismatch } from "./types.js";
import { validateInput } from "./validate-input.js";
import { validateSignalPayload } from "./validate-signal.js";
import { RunControl, abortedNodeError, isPausedContinuationState } from "./run-control.js";
import { evaluateTemplatedValue, evaluateWorkflowOutputs } from "./workflow-outputs.js";
import { randomBytes } from "node:crypto";
import pLimit from "p-limit";
import { AgentTelemetryAccumulator, upsertAgentAttemptTelemetry } from "./agent-telemetry.js";
import { buildWorkflowExpressionContext } from "./workflow-context.js";
import { HookRunner, HookFailureError } from "./hooks/runner.js";
import { HookJournal } from "./hooks/journal.js";
import { basePayload, runScope, withNodeFields, type RunScope } from "./hooks/payload.js";
import type { AgentInjectorResult, EventName, HookAgentTelemetry, HookPayload, InjectorName, InjectorResult, ProgramInjectorResult } from "@acpus/core";
import { isRunTerminal } from "./types.js";
import { join } from "node:path";

/**
 * The core IR interpreter that drives state transitions, orchestrates
 * execution, and persists state.
 */
export class WorkflowInterpreter {
  private readonly store: RunStore;
  private readonly evaluator: ExpressionEvaluator;
  private readonly agentExecutor: ExecutorAdapter<AgentExecutionRequest>;
  private readonly programExecutor: ExecutorAdapter<ProgramExecutionRequest>;
  private readonly artifactStore: ArtifactStore;
  private readonly attemptArtifacts: AttemptArtifactRecorder;
  private readonly runControl: RunControl;
  private readonly maxConcurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Frozen hook runner for this Run; undefined disables all hook machinery. */
  private readonly hookRunner?: HookRunner;
  /** Lazily-created per-Run injector journal (only when injectors fire). */
  private hookJournal?: HookJournal;
  /**
   * Per-node leaf execution metadata for hook onNodeComplete/Error payloads,
   * keyed by node key. Populated by executeProgram/executeAgent and deleted by
   * executeNode once the node's terminal lifecycle events have fired, so the map
   * never accumulates across a long-lived Run.
   */
  private readonly leafMeta = new Map<string, LeafHookMeta>();

  /** Pending external-decision resolvers for Signal Nodes awaiting a payload,
   *  keyed by "runId:nodeKey". An entry exists only while a node is `awaiting`.
   *  The resolver validates the payload against the node's output schema and
   *  throws on mismatch, leaving the node `awaiting`. */
  private readonly signalResolvers: Map<string, (payload: unknown) => void> = new Map();

  /** Absolute paths of subworkflow specs currently on the execution stack (cycle guard). */
  private readonly subworkflowStack: Set<string> = new Set();

  constructor(
    store: RunStore,
    agentExecutor: ExecutorAdapter<AgentExecutionRequest>,
    programExecutor: ExecutorAdapter<ProgramExecutionRequest>,
    options?: InterpreterOptions
  ) {
    this.store = store;
    this.evaluator = new ExpressionEvaluator({ nowTimestamp: options?.nowTimestamp });
    this.agentExecutor = agentExecutor;
    this.programExecutor = programExecutor;
    this.artifactStore = new ArtifactStore(store.getBaseDir());
    this.attemptArtifacts = new AttemptArtifactRecorder(this.artifactStore);
    this.runControl = new RunControl(store);
    this.maxConcurrency = options?.maxConcurrency ?? 10;
    this.sleep = options?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.hookRunner = options?.hookRunner;
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
    const runId = opts.runId ?? generateRunId();
    return this.store.initRun(runId, ir, validatedInput, {
      workflowRef: opts.workflowRef,
      workflowSourcePath: opts.workflowSourcePath,
      agentOverrides: opts.agentOverrides,
      submissionWarnings: opts.submissionWarnings,
      skipHooks: opts.skipHooks
    });
  }

  /**
   * Execute a previously-initialized run to its terminal state.
   */
  async runToCompletion(ir: AcpusIr, opts: RunOptions, runId: string): Promise<import("./types.js").RunState> {
    const meta = this.store.readRunMeta(runId)!;
    const scope = this.hookRunner ? runScope(ir, meta) : undefined;
    // `beforeRun` fires only at the first execution entry (no node states yet),
    // never on retry/resume where the Run is already underway.
    const isFirstExecution = this.store.listNodeStates(runId).length === 0;
    if (scope && isFirstExecution) {
      await this.emitRunEvent("beforeRun", scope, (p) => {
        p.input = opts.input;
        p.run_attempt = meta.runAttempt;
        p.ir_digest = meta.irDigest;
      });
    }
    const runStartedAt = Date.now();
    try {
      const ctx = this.buildContext(ir, opts.input, runId);
      await this.executeNode(ir.root, ctx, runId, {});
      meta.output = evaluateWorkflowOutputs(ir, ctx, this.evaluator);
      meta.error = undefined;
      meta.status = "completed";
    } catch (error) {
      const rootState = this.store.readNodeState(runId, resolveNodeKey(ir.root.keyTemplate));
      if (rootState?.state === "paused") {
        meta.status = "paused";
      } else if (rootState?.state === "cancelled") {
        meta.status = "cancelled";
      } else {
        meta.status = "failed";
        meta.output = undefined;
        meta.error = errorMessage(error);
        if (rootState?.state === "completed") {
          rootState.state = "failed";
          rootState.error = meta.error;
          rootState.completedAt = new Date().toISOString();
          this.store.writeTerminalNodeState(runId, rootState);
        }
      }
    } finally {
      // Clean up per-runId scheduling guards when the run settles,
      // so they don't leak memory across runs.
      this.runControl.clearSchedulingGuards(runId);
    }

    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);

    // `afterRun` fires once the Run reaches a terminal status.
    if (scope && isRunTerminal(meta.status)) {
      await this.emitRunEvent("afterRun", scope, (p) => {
        p.run_status = meta.status;
        p.run_attempt = meta.runAttempt;
        p.ir_digest = meta.irDigest;
        p.duration_ms = Date.now() - runStartedAt;
        if (meta.output !== undefined) p.output = meta.output;
        if (meta.error !== undefined) p.error = meta.error;
      });
    }
    return meta;
  }

  /**
   * Reset any nodes persisted as `running` (or `awaiting`) back to `pending`
   * (crash recovery). Safe to call when adopting a Run after a supervisor
   * restart: in-memory abort controllers and signal resolvers are gone, so a
   * node marked `running`/`awaiting` on disk has no live execution and must be
   * re-runnable. An `awaiting` Signal Node re-registers its resolver and waits
   * for a fresh external decision on re-execution.
   */
  recoverStaleNodes(runId: string): void {
    this.runControl.recoverStaleNodes(runId);
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
    const ctx = this.buildContext(ir, input, runId);
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
    const nodeKey = withNodeKeyPrefix(keyPrefix, resolved);
    const rec = recorded.get(nodeKey);

    // A node absent from the recording was never reached on the original walk
    // (e.g. an untaken switch branch); skip it so we don't fabricate topology.
    if (!rec) return;
    reached.set(nodeKey, rec.state);

    // Feed the recorded output into the step context so downstream decisions
    // re-derive identically. Leaves contribute their output; containers below
    // populate ctx.steps for their own children as they descend.
    if (rec.output !== undefined) ctx.steps[node.id] = expressionOutputForNode(node, rec.output);

    switch (node.kind) {
      case "pipeline":
        for (const child of node.children ?? []) {
          this.replayNode(child, ctx, runId, dynamic, keyPrefix, recorded, reached, evaluator);
        }
        break;
      case "parallel":
        (node.branches ?? []).forEach((branch) => {
          const branchDynamic = nestedParallelBranchDynamic(dynamic, branch.id);
          const branchCtx: ExpressionContext = { ...ctx, steps: { ...ctx.steps } };
          this.replayNode(branch.child, branchCtx, runId, branchDynamic, keyPrefix, recorded, reached, evaluator);
        });
        break;
      case "fanout": {
        const overExpr = node.metadata.over as string | undefined;
        const items = overExpr ? evaluator.evaluateOverExpression(overExpr, ctx) : [];
        items.forEach((item, index) => {
          const keyCtx: ExpressionContext = { ...ctx, item, item_index: index };
          const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index, keyCtx, evaluator);
          const itemDynamic = appendDynamicFrame(dynamic, { fanoutItemId: itemId, laneId: String(index) });
          const itemCtx: ExpressionContext = { ...keyCtx, steps: { ...ctx.steps }, item_id: itemId };
          for (const child of node.children ?? []) {
            this.replayNode(child, itemCtx, runId, itemDynamic, keyPrefix, recorded, reached, evaluator);
          }
        });
        break;
      }
      case "if":
      case "switch":
        for (const branch of node.branches ?? []) {
          const taken = !branch.when || Boolean(evaluator.evaluateExpression(branch.when, ctx));
          if (taken) {
            this.replayNode(branch.child, ctx, runId, dynamic, keyPrefix, recorded, reached, evaluator);
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
          const loopDynamic = appendDynamicFrame(dynamic, { loopRound: iter });
          if (untilExpr && iter > 0 && evaluator.evaluateExpression(untilExpr, loopCtx)) break;
          // Only descend while this round's children were actually recorded.
          let anyChildReached = false;
          for (const child of node.children ?? []) {
            const before = reached.size;
            this.replayNode(child, loopCtx, runId, loopDynamic, keyPrefix, recorded, reached, evaluator);
            if (reached.size > before) anyChildReached = true;
            const childKey = withNodeKeyPrefix(keyPrefix, resolveNodeKey(child.keyTemplate, loopDynamic));
            const recordedOutput = recorded.get(childKey)?.output;
            lastOutput = recordedOutput !== undefined ? primaryOutput(expressionOutputForNode(child, recordedOutput)) : lastOutput;
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
      // run.agent / run.program / run.signal are leaves: their recorded state
      // was already captured above; nothing further to descend.
      default:
        break;
    }
  }

  /**
   * Retry a failed executable Node. This is a local repair operation for the
   * target executable only; Run-level retry remains the operation that restores
   * Workflow progress from failed composite ancestors.
   */
  async retryNode(runId: string, nodeKey: string): Promise<void> {
    const { state, ir, input } = this.runControl.prepareNodeRetry(runId, nodeKey);

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
    this.runControl.resetNodeForRetry(runId, state);

    const ctx = this.buildContext(ir, input, runId);
    const retryTarget = this.hydrateContextForNodeRetry(ir.root, ctx, runId, nodeKey, {});
    // Restore the parent dynamic value-context captured at first execution.
    const retryCtx = retryTarget?.ctx ?? ctx;
    this.restoreDynamicContext(retryCtx, state.dynamicContext);
    // Retry re-runs the executable as a continuation: agents keep the same acpx
    // session name and receive the fixed continuation prompt. The original full
    // node key is preserved for stable identity.
    await this.executeNode(node, retryCtx, runId, retryTarget?.dynamic ?? {}, undefined, true, nodeKey);
  }

  // ─── Run-level controls ─────────────────────────────────────────

  /**
   * Pause an entire Run. Validates Run is `running`, sets scheduling guard,
   * pauses all running nodes, and updates Run metadata to `paused`.
   */
  pauseRun(runId: string): void {
    this.runControl.pauseRun(runId);
  }

  /**
   * Cancel an entire Run. Validates Run is `running` or `paused`, sets
   * scheduling guard, cancels running nodes, marks pending nodes as cancelled,
   * and updates Run metadata to `cancelled`.
   */
  cancelRun(runId: string): void {
    this.runControl.cancelRun(runId);
  }

  /**
   * Resume an entire paused Run. Validates Run is `paused`, clears scheduling
   * guards, recovers stale nodes, and re-executes from root.
   */
  async resumeRun(runId: string): Promise<void> {
    this.runControl.resumeRun(runId);
  }

  /**
   * Retry a failed Run. Validates Run is `failed`, resets failed materialized
   * nodes to pending (preserving completed), clears scheduling guards, and
   * re-executes from root. Same Run ID, no new Run.
   */
  retryRun(runId: string): void {
    this.runControl.retryRun(runId);
  }

  // ─── Node execution dispatch ──────────────────────────────────

  private async executeNode(
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    dynamic: NodeKeyDynamic,
    keyPrefix?: string,
    isContinuation?: boolean,
    overrideNodeKey?: string
  ): Promise<unknown> {
    // On continuation/retry the full resolved node key is supplied directly so the
    // node's stable identity (and thus the agent's acpx session name) survives
    // across loop/fanout/lane/subworkflow dynamics that are not re-derived here.
    const resolved = resolveNodeKey(node.keyTemplate, dynamic);
    const nodeKey = overrideNodeKey ?? withNodeKeyPrefix(keyPrefix, resolved);

    // Check if already completed (from prior run)
    const existing = this.store.readNodeState(runId, nodeKey);
    if (existing?.state === "completed") {
      const expressionOutput = expressionOutputForNode(node, existing.output);
      ctx.steps[node.id] = expressionOutput;
      return expressionOutput;
    }
    if (existing?.state === "cancelled" || existing?.state === "paused") {
      throw new NodeAbortedError(nodeKey, existing.state);
    }
    const continuation = Boolean(
      isContinuation || isPausedContinuationState(existing)
    );

    // Initialize state
    const definitionHash = hashIrNode(node, { workflow: ctx.workflow });
    const state = existing ?? createInitialNodeState(nodeKey, node.id, node.kind, definitionHash);
    if (!state.definitionHash) state.definitionHash = definitionHash;
    if (state.state === "failed") {
      throw new Error(`Node ${nodeKey} is in failed state`);
    }

    const schedulingAbort = this.runControl.applySchedulingGuard(runId, state);
    if (schedulingAbort) {
      throw new NodeAbortedError(nodeKey, schedulingAbort);
    }

    // Set up abort controller
    const controller = new AbortController();
    this.runControl.registerAbortController(runId, nodeKey, controller);

    // Transition to running
    const fromState = state.state;
    if (canTransition(state.state, "running")) {
      state.state = transition(state.state, "running") as NodeState;
    }
    state.attempt++;
    state.startedAt = new Date().toISOString();
    // Snapshot the parent dynamic value-context (fanout item / loop round) for
    // executable leaves so retry/continuation can re-render their command/prompt
    // without the parent re-deriving item/loop. Only captured on fresh entry
    // (retry/continuation restore it from disk into ctx).
    if (!continuation && (node.kind === "run.agent" || node.kind === "run.program")) {
      const snapshot = this.captureDynamicContext(ctx);
      if (snapshot) state.dynamicContext = snapshot;
    }
    this.store.writeNodeState(runId, state);
    if (fromState !== "running") {
      await this.emitNodeLifecycle(runId, "onNodeStart", node, nodeKey, state, dynamic, ctx, fromState);
    }

    try {
      let output: unknown;
      let completeScope = false;
      // Artifact refs produced by a leaf execution in this call frame. Kept as a
      // local (not a shared field) so concurrent parallel/fanout siblings can't
      // clobber each other's refs.
      let artifactRefs: string[] | undefined;

      switch (node.kind) {
        case "pipeline":
          output = await this.executePipeline(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "run.agent": {
          const leaf = await this.executeAgent(node, ctx, runId, controller.signal, nodeKey, continuation);
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
          output = await this.executeParallel(node, ctx, runId, dynamic, nodeKey, keyPrefix);
          break;
        case "fanout":
          output = await this.executeFanout(node, ctx, runId, dynamic, nodeKey, keyPrefix);
          break;
        case "if":
          output = await this.executeIf(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "switch":
          output = await this.executeSwitch(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "loop":
          output = await this.executeLoop(node, ctx, runId, dynamic, keyPrefix);
          break;
        case "guard": {
          const guard = this.executeGuard(node, ctx);
          output = guard.output;
          completeScope = guard.completeScope;
          break;
        }
        case "run.signal":
          output = await this.executeSignal(node, ctx, runId, controller.signal, nodeKey);
          break;
        case "subworkflow":
          output = await this.executeSubworkflow(node, ctx, runId, dynamic, nodeKey);
          break;
        default:
          throw new Error(`Unknown node kind: ${node.kind}`);
      }

      const expressionOutput = expressionOutputForNode(node, output);

      // If a Run-level resume already re-entered this node, a late result from
      // the old attempt must not overwrite the newer attempt's state.
      if (this.runControl.isStaleAttemptOnDisk(runId, nodeKey, state.attempt, state.startedAt)) {
        return expressionOutput;
      }
      this.runControl.syncInFrameAttemptFromDisk(runId, nodeKey, state);
      this.syncAgentTelemetryFromDisk(runId, nodeKey, state);

      // Transition to completed unless an external pause/cancel already changed
      // this node's state on disk while we were awaiting the leaf.
      const abortedState = this.runControl.readAbortedStateOnDisk(runId, nodeKey);
      if (abortedState) {
        throw new NodeAbortedError(nodeKey, abortedState, artifactRefs, output);
      }
      state.state = "completed";
      state.error = undefined;
      state.output = output;
      if (artifactRefs) state.artifactRefs = artifactRefs;
      state.completedAt = new Date().toISOString();
      // A Signal Node completes from `awaiting`, every other leaf from `running`.
      const completeFrom: NodeState = node.kind === "run.signal" ? "awaiting" : "running";
      this.store.writeTerminalNodeState(runId, state);
      await this.emitNodeLifecycle(runId, "onNodeComplete", node, nodeKey, state, dynamic, ctx, completeFrom);

      // Add output to step context
      ctx.steps[node.id] = expressionOutput;

      if (completeScope) {
        throw new ScopeCompleted(expressionOutput);
      }

      return expressionOutput;
    } catch (error) {
      if (error instanceof ScopeCompleted) {
        throw error;
      }

      if (error instanceof NodeAbortedError) {
        if (this.runControl.isStaleAttemptOnDisk(runId, nodeKey, state.attempt, state.startedAt)) {
          throw error;
        }
        this.runControl.syncInFrameAttemptFromDisk(runId, nodeKey, state);
        // Transition this node to the same state as the child that was aborted.
        state.state = error.state === "paused" ? "paused" : "cancelled";
        state.error = abortedNodeError(error.state);
        // Preserve any output + partial Agent artifacts from the aborted leaf.
        if (error.output !== undefined) state.output = error.output;
        if (error.artifactRefs) state.artifactRefs = error.artifactRefs;
        this.syncAgentTelemetryFromDisk(runId, nodeKey, state);
        if (state.state === "cancelled") {
          this.store.writeTerminalNodeState(runId, state);
        } else {
          this.store.writeNodeState(runId, state);
        }
        await this.emitNodeLifecycle(
          runId,
          error.state === "paused" ? "onNodePaused" : "onNodeCancelled",
          node, nodeKey, state, dynamic, ctx, "running"
        );
        throw error;
      }

      // Don't clobber an external pause/cancel that landed while this node's
      // leaf was failing; keep the control-plane abort as the observed outcome.
      if (this.runControl.isStaleAttemptOnDisk(runId, nodeKey, state.attempt, state.startedAt)) {
        throw error;
      }
      this.runControl.syncInFrameAttemptFromDisk(runId, nodeKey, state);
      const abortedState = this.runControl.readAbortedStateOnDisk(runId, nodeKey);
      if (abortedState) {
        throw new NodeAbortedError(nodeKey, abortedState);
      }
      state.state = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      // Preserve artifacts and invalid output a leaf produced before failing.
      if (error instanceof LeafExecutionError) {
        if (error.artifactRefs) state.artifactRefs = error.artifactRefs;
        if (error.output !== undefined) state.output = error.output;
      }
      if (error instanceof GuardFailureError) {
        state.output = error.output;
      }
      this.syncAgentTelemetryFromDisk(runId, nodeKey, state);
      state.completedAt = new Date().toISOString();
      this.store.writeTerminalNodeState(runId, state);
      await this.emitNodeLifecycle(runId, "onNodeError", node, nodeKey, state, dynamic, ctx, "running", error);
      throw error;
    } finally {
      this.runControl.clearInFlightNode(runId, nodeKey);
      // Drop per-node leaf hook metadata so the map never grows across a Run.
      this.clearLeafMeta(nodeKey);
    }
  }

  // ─── Kind-specific execution ───────────────────────────────────

  private async executePipeline(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const children = node.children ?? [];
    if (node.metadata.implicit === true) {
      for (const child of children) {
        try {
          await this.executeNode(child, ctx, runId, dynamic, keyPrefix);
        } catch (error) {
          if (error instanceof ScopeCompleted) return { output: { ...ctx.steps } };
          throw error;
        }
      }
      return { output: { ...ctx.steps } };
    }

    const frame: ExpressionContext = { ...ctx, steps: { ...ctx.steps } };
    let lastOutput: unknown;
    for (const child of children) {
      try {
        lastOutput = await this.executeNode(child, frame, runId, dynamic, keyPrefix);
      } catch (error) {
        if (error instanceof ScopeCompleted) return { output: primaryOutput(error.output) };
        throw error;
      }
    }
    if (isRecord(node.metadata.outputs)) {
      return { output: evaluateWorkflowOutputs({ outputs: node.metadata.outputs } as AcpusIr, frame, this.evaluator) };
    }
    return { output: primaryOutput(lastOutput) };
  }

  private async executeAgent(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string, continuation?: boolean): Promise<LeafResult> {
    const retry = node.metadata.retry as { max?: number; backoff?: string } | undefined;
    const hasOutputSchema = node.metadata.output !== undefined;
    const maxRetries = typeof retry?.max === "number" ? retry.max : hasOutputSchema ? 2 : 0;
    const backoffMs = retry?.backoff ? parseDurationMs(retry.backoff) : 5e3;
    const allArtifactRefs: string[] = [...(this.store.readNodeState(runId, nodeKey)?.artifactRefs ?? [])];

    // Run `beforeAgentExec` once per Agent Step execution (per persisted attempt),
    // not per internal parse/schema auto-retry iteration. The returned prompt
    // prefix is prepended to every rendered prompt below.
    const injectedPrompt = await this.runInjector("beforeAgentExec", node, ctx, runId, nodeKey, (p) => {
      p.agent_use = (node.metadata.agent as { use?: string } | undefined)?.use;
      p.is_continuation = Boolean(continuation);
    }) as AgentInjectorResult | undefined;

    // `attempt` is local to this executor call and controls parse/schema
    // auto-retry. The persisted `state.attempt` is the durable attempt sequence
    // used for node state and artifact filenames across pause/resume/manual retry.
    for (let attempt = 0; ; attempt++) {
      const attemptNo = this.store.readNodeState(runId, nodeKey)?.attempt ?? attempt + 1;
      let preparedPrompt: string;
      let renderedSessionKey: string | undefined;
      try {
        preparedPrompt = renderAgentRequestPrompt(node, ctx, this.evaluator, Boolean(continuation), attempt > 0);
        renderedSessionKey = renderAgentSessionKey(node, ctx, this.evaluator);
      } catch (error) {
        const use = (node.metadata.agent as { use?: string } | undefined)?.use ?? "?";
        throw new LeafExecutionError(
          `Agent step '${node.id}' (use: ${use}) failed (config): Failed to evaluate agent configuration template: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (injectedPrompt?.prependPrompt) {
        preparedPrompt = `${injectedPrompt.prependPrompt}\n\n${preparedPrompt}`;
      }

      const rawAcpDebug = process.env.ACPUS_AGENT_RAW_ACP_DEBUG === "1";
      const liveArtifacts = this.attemptArtifacts.startAgentAttempt(runId, nodeKey, attemptNo, preparedPrompt, { rawAcpDebug });
      this.attemptArtifacts.mergeAttemptRefs(allArtifactRefs, liveArtifacts.artifactRefs);
      this.publishRenderedPrompt(runId, nodeKey, preparedPrompt);
      if (attempt === 0 && renderedSessionKey !== undefined) {
        this.publishRenderedAgentSessionKey(runId, nodeKey, renderedSessionKey);
      }

      const streamDiagnostics: string[] = [];
      let sawStdoutStream = false;
      const activity = new AgentTelemetryAccumulator({
        attempt: attemptNo,
        inputText: preparedPrompt,
        inputArtifactRef: liveArtifacts.promptRef,
        onTelemetry: (attemptTelemetry) => {
          this.publishAgentTelemetry(runId, nodeKey, attemptTelemetry);
        }
      });
      this.publishRunningAgentAttempt(runId, nodeKey, allArtifactRefs, activity.snapshot("running"));

      const result = await this.agentExecutor.execute({
        kind: "agent",
        node,
        context: ctx,
        signal,
        nodeKey,
        prompt: preparedPrompt,
        sessionKey: renderedSessionKey,
        continuation,
        retry: attempt > 0,
        onStream: (stream, chunk) => {
          if (stream === "stdout" && chunk.length > 0) {
            sawStdoutStream = true;
            if (rawAcpDebug) {
              try {
                this.attemptArtifacts.appendAgentRawAcpDebug(runId, nodeKey, attemptNo, chunk);
              } catch (error) {
                streamDiagnostics.push(`failed to append raw ACP debug stream: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            try {
              activity.append(chunk);
            } catch (error) {
              streamDiagnostics.push(`failed to parse live agent telemetry: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      });
      try {
        if (!sawStdoutStream && result.stdout !== undefined) activity.append(result.stdout);
        if (result.acpxRecordId) activity.setAcpxRecordId(result.acpxRecordId);
        if (result.cwd) activity.setCwd(result.cwd);
        activity.flush();
      } catch (error) {
        streamDiagnostics.push(`failed to parse live agent telemetry: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.responseText !== undefined) activity.setResponseText(result.responseText);

      const abortIntent = result.partial ? this.runControl.abortIntent(runId, nodeKey) : undefined;
      const finalAttemptState: AgentAttemptTelemetryState = abortIntent
        ?? (result.failureKind || (result.error && !result.partial) ? "failed" : "completed");
      const completedAt = new Date().toISOString();

      // Persist per-attempt human-readable agent IO plus diagnostics
      // when the executor exposed them. Refs flow back to executeNode via the
      // return value / thrown error (no shared mutable field).
      const finalized = result.responseText !== undefined || result.stderr !== undefined
        ? this.attemptArtifacts.finalizeAgentAttempt(runId, nodeKey, attemptNo, {
          responseText: result.responseText,
          stderr: result.stderr,
          diagnostics: streamDiagnostics
        })
        : result.artifactRefs;
      const artifactRefs = Array.isArray(finalized) ? finalized : finalized?.artifactRefs;
      const responseRef = !Array.isArray(finalized) ? finalized?.responseRef : undefined;
      if (responseRef) activity.setOutputArtifactRef(responseRef);
      const finalTelemetry = activity.snapshot(finalAttemptState, completedAt);
      const telemetryRef = this.attemptArtifacts.writeAgentTelemetry(runId, nodeKey, attemptNo, finalTelemetry);
      this.publishAgentTelemetry(runId, nodeKey, finalTelemetry);
      if (artifactRefs) this.attemptArtifacts.mergeAttemptRefs(allArtifactRefs, artifactRefs);
      this.attemptArtifacts.mergeAttemptRefs(allArtifactRefs, [telemetryRef]);

      if (result.partial) {
        // Operator abort → carry output + partial Agent artifact refs on the abort error;
        // executeNode persists the paused/cancelled state.
        throw new NodeAbortedError(nodeKey, abortIntent ?? "paused", allArtifactRefs.length > 0 ? allArtifactRefs : undefined, result.output);
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

      // Stash agent detail for hook onNodeComplete/Error payloads (terminal attempt).
      if (this.hookRunner) {
        const agent = node.metadata.agent as { use?: string; model?: string; type?: string } | undefined;
        this.leafMeta.set(nodeKey, {
          failureKind: result.failureKind,
          agentModel: agent?.model,
          agentType: agent?.type,
          agentPolicy: (node.metadata.policy as string | undefined) ?? (agent as { policy?: string } | undefined)?.policy,
          sessionKey: renderedSessionKey,
          agentExitCode: result.exitCode,
          agentResponseText: result.responseText
        });
      }

      if (result.failureKind || (result.error && !result.partial)) {
        const use = (node.metadata.agent as { use?: string } | undefined)?.use ?? "?";
        throw new LeafExecutionError(
          `Agent step '${node.id}' (use: ${use}) failed${result.failureKind ? ` (${result.failureKind})` : ""}: ${result.error ?? "unknown"}`,
          allArtifactRefs.length > 0 ? allArtifactRefs : artifactRefs,
          result.output
        );
      }

      // Agent output is wrapped in an envelope for parity with program steps.
      return {
        output: { output: result.output },
        artifactRefs: allArtifactRefs.length > 0 ? allArtifactRefs : artifactRefs
      };
    }
  }

  private async executeProgram(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<LeafResult> {
    // Run `beforeProgramExec` before the executor call. cmd/env render inside
    // the executor, so injected env is passed through ExecutionRequest and the
    // executor merges it into the subprocess environment.
    const injected = await this.runInjector("beforeProgramExec", node, ctx, runId, nodeKey) as ProgramInjectorResult | undefined;
    const result = await this.programExecutor.execute({
      kind: "program",
      node,
      context: ctx,
      signal,
      nodeKey,
      injectedEnv: injected?.env
    });

    // Stash rendered command/env/output for hook onNodeComplete/Error payloads.
    if (this.hookRunner) {
      this.leafMeta.set(nodeKey, {
        failureKind: result.failureKind,
        command: result.command,
        shell: result.shell,
        subprocessEnv: result.subprocessEnv,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    // Operator abort → paused/cancelled (carry output on the abort error).
    if (result.partial) {
      throw new NodeAbortedError(nodeKey, this.runControl.abortIntent(runId, nodeKey), undefined, result.output);
    }

    // Always persist stdout/stderr as artifacts (even when empty). An artifact
    // write failure is itself non-recoverable.
    const artifactRefs = this.attemptArtifacts.writeProgramArtifacts(runId, nodeKey, result.stdout ?? "", result.stderr ?? "");

    // Non-recoverable failures fail the node.
    if (result.failureKind) {
      throw new LeafExecutionError(`Program step '${node.id}' failed (${result.failureKind}): ${result.error ?? "unknown"}`, artifactRefs);
    }

    // exit code is allow-listed by `expect.exit_code` (default `[0]`); other
    return { output: { output: result.output, exit_code: result.exitCode ?? 0 }, artifactRefs };
  }

  private publishRunningAgentAttempt(runId: string, nodeKey: string, artifactRefs: string[], attemptTelemetry: AgentAttemptTelemetry): void {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) return;
    state.artifactRefs = [...artifactRefs];
    state.agentTelemetry = upsertAgentAttemptTelemetry(state.agentTelemetry, attemptTelemetry);
    this.store.writeNodeState(runId, state);
  }

  private publishRenderedAgentSessionKey(runId: string, nodeKey: string, renderedSessionKey: string | undefined): void {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) return;
    state.renderedSessionKey = renderedSessionKey;
    this.store.writeNodeState(runId, state);
  }

  private publishRenderedPrompt(runId: string, nodeKey: string, renderedPrompt: string): void {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) return;
    state.renderedPrompt = renderedPrompt;
    this.store.writeNodeState(runId, state);
  }

  private publishAgentTelemetry(runId: string, nodeKey: string, attemptTelemetry: AgentAttemptTelemetry): void {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) return;
    state.agentTelemetry = upsertAgentAttemptTelemetry(state.agentTelemetry, attemptTelemetry);
    this.store.writeNodeState(runId, state);
  }

  private syncAgentTelemetryFromDisk(runId: string, nodeKey: string, state: NodeExecutionState): void {
    const persisted = this.store.readNodeState(runId, nodeKey);
    state.agentTelemetry = persisted?.agentTelemetry ?? state.agentTelemetry;
    state.renderedSessionKey = persisted?.renderedSessionKey ?? state.renderedSessionKey;
    state.renderedPrompt = persisted?.renderedPrompt ?? state.renderedPrompt;
  }

  private async executeParallel(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, nodeKey: string, keyPrefix?: string): Promise<unknown> {
    const branches = node.branches ?? [];
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;
    const join = (node.metadata.join as string) ?? "all";

    if (join === "all") {
      branches.forEach((branch) => {
        this.materializePendingNode(runId, branch.child, ctx, nestedParallelBranchDynamic(dynamic, branch.id), keyPrefix);
      });
    }

    const limit = pLimit(maxConcurrency);
    const branchPromises = branches.map((branch) =>
      limit(async () => {
        const branchDynamic = nestedParallelBranchDynamic(dynamic, branch.id);
        let output: unknown;
        try {
          output = await this.executeNode(branch.child, { ...ctx, steps: { ...ctx.steps } }, runId, branchDynamic, keyPrefix);
        } catch (error) {
          if (error instanceof ScopeCompleted) {
            output = error.output;
          } else {
            throw error;
          }
        }
        return { branch, output };
      })
    );

    if (join === "race") {
      try {
        // First branch to settle wins; losers are not cancelled but silently
        // consumed so their later rejection doesn't surface as unhandled.
        const winner = await Promise.race(branchPromises);
        branchPromises.forEach((p) => void p.catch(() => undefined));
        const mapOutput: Record<string, unknown> = { [winner.branch.id]: primaryOutput(winner.output) };
        return { output: mapOutput };
      } catch (error) {
        if (!(error instanceof NodeAbortedError)) {
          this.runControl.cancelDescendantsInScope(runId, nodeKey);
        }
        branchPromises.forEach((p) => void p.catch(() => undefined));
        throw error;
      }
    }

    // join: all — collect every branch output keyed by step id.
    // fail-fast: Promise.all rejects on the first branch failure. Before
    // rethrowing, actively cancel the still-running sibling branches so they
    // don't linger in "running" state (they belong to a parallel that has
    // already failed). Siblings transition to "cancelled".
    let results: { branch: NonNullable<IrNode["branches"]>[number]; output: unknown }[];
    try {
      results = await Promise.all(branchPromises);
    } catch (error) {
      if (!(error instanceof NodeAbortedError)) {
        // Genuine failure or cancel — fast-stop: cancel still-running siblings
        this.runControl.cancelDescendantsInScope(runId, nodeKey);
      }
      branchPromises.forEach((p) => void p.catch(() => undefined));
      throw error;
    }
    const mapOutput: Record<string, unknown> = {};
    for (const { branch, output } of results) {
      mapOutput[branch.id] = primaryOutput(output);
    }
    return { output: mapOutput };
  }

  private async executeFanout(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, nodeKey: string, keyPrefix?: string): Promise<unknown> {
    const overExpr = node.metadata.over as string;
    if (!overExpr) {
      throw new Error(`fanout node ${node.id} missing 'over' expression`);
    }

    const items = this.evaluator.evaluateOverExpression(overExpr, ctx);
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;
    const join = (node.metadata.join as string) ?? "all";
    const quorum = node.metadata.quorum as number | undefined;
    const successCriteria = node.metadata.success_criteria as { min_success?: number } | undefined;
    const body = node.children?.[0];
    if (!body) {
      throw new Error(`fanout node ${node.id} missing body pipeline`);
    }

    const limit = pLimit(maxConcurrency);

    // Success target (how many lanes must succeed). Default follows join.
    const defaultMinSuccess = join === "race" ? 1 : join === "quorum" ? (quorum ?? 1) : items.length;
    const minSuccess = successCriteria?.min_success ?? defaultMinSuccess;

    const lanePlan = items.map((item, index) => {
      const keyCtx: ExpressionContext = { ...ctx, item, item_index: index };
      const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index, keyCtx, this.evaluator);
      const laneDynamic = appendDynamicFrame({}, { fanoutItemId: itemId, laneId: String(index) });
      return {
        itemId,
        keyCtx,
        itemDynamic: laneDynamic
      };
    });

    if (join === "all") {
      for (const lane of lanePlan) {
        const itemDynamic = appendDynamicFrames(dynamic, lane.itemDynamic);
        this.materializePendingNode(runId, body, lane.keyCtx, itemDynamic, keyPrefix);
      }
    }

    // Fail-fast: once enough lanes have failed that the success target is
    // unreachable (failures > total - minSuccess), abort the whole fanout —
    // cancel every still-running/pending lane subtree and reject to short
    // circuit the wait, instead of waiting for doomed lanes to finish.
    // race/quorum tolerate per-lane failure until their target is impossible.
    const maxFailures = items.length - minSuccess;
    let failures = 0;
    let failFastTriggered = false;

    // Each lane resolves to a LaneResult. A tolerable failure is captured (does
    // not reject) so the join/min_success logic can run. A NodeAbortedError
    // (operator pause/cancel) re-throws so it propagates to the parent.
    const lanePromises = lanePlan.map((lane) =>
      limit(async (): Promise<LaneResult> => {
        const itemDynamic = appendDynamicFrames(dynamic, lane.itemDynamic);
        const itemCtx: ExpressionContext = {
          ...lane.keyCtx,
          steps: { ...ctx.steps },
          item_id: lane.itemId
        };
        try {
          const laneOutput = await this.executeNode(body, itemCtx, runId, itemDynamic, keyPrefix);
          return { ok: true, output: primaryOutput(laneOutput) };
        } catch (error) {
          if (error instanceof ScopeCompleted) return { ok: true, output: primaryOutput(error.output) };
          if (error instanceof NodeAbortedError) {
            throw error;
          }
          failures++;
          if (failures > maxFailures) {
            // Success target is now unreachable → fail fast: cancel all
            // still-running lanes of THIS fanout (scoped to the parent dynamic,
            // so it spans every lane), then reject to short-circuit the wait.
            if (!failFastTriggered) {
              failFastTriggered = true;
              this.runControl.cancelDescendantsInScope(runId, nodeKey);
            }
            throw error;
          }
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );

    // Wait strategy.
    const settled = await this.waitForFanout(lanePromises, join, quorum);

    const successes = settled.filter((r): r is { ok: true; output: unknown } => r.ok);
    if (successes.length < minSuccess) {
      throw new Error(`fanout ${node.id}: ${successes.length} successful lanes, requires ${minSuccess}`);
    }

    // outputMerge: "array" of successful lane outputs.
    return { output: successes.map((r) => r.output) };
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

    // join: all — wait for every lane. A lane only rejects under fail-fast
    // (first failure) or NodeAbortedError; either way Promise.all short-circuits
    // and the rejection propagates to fail the fanout immediately.
    return Promise.all(lanePromises);
  }

  private materializePendingNode(runId: string, node: IrNode, ctx: ExpressionContext, dynamic: NodeKeyDynamic, keyPrefix?: string): void {
    const resolved = resolveNodeKey(node.keyTemplate, dynamic);
    const nodeKey = withNodeKeyPrefix(keyPrefix, resolved);
    if (this.store.readNodeState(runId, nodeKey)) return;
    this.store.writeNodeState(runId, createInitialNodeState(nodeKey, node.id, node.kind, hashIrNode(node, { workflow: ctx.workflow })));
  }

  private async executeSwitch(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const branches = node.branches ?? [];

    for (const branch of branches) {
      if (branch.when && !this.evaluator.evaluateExpression(branch.when, ctx)) continue;
      // Default branch has no condition and is reached only after earlier cases fail.
      try {
        return { output: primaryOutput(await this.executeNode(branch.child, ctx, runId, dynamic, keyPrefix)) };
      } catch (error) {
        if (error instanceof ScopeCompleted) return { output: primaryOutput(error.output) };
        throw error;
      }
    }

    throw new Error(`Switch node ${node.id}: no branch matched and no default`);
  }

  private async executeIf(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const branches = node.branches ?? [];

    for (const branch of branches) {
      if (branch.when && !this.evaluator.evaluateExpression(branch.when, ctx)) continue;
      try {
        return { output: primaryOutput(await this.executeNode(branch.child, ctx, runId, dynamic, keyPrefix)) };
      } catch (error) {
        if (error instanceof ScopeCompleted) return { output: primaryOutput(error.output) };
        throw error;
      }
    }

    return { output: {} };
  }

  private async executeLoop(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, keyPrefix?: string): Promise<unknown> {
    const untilExpr = node.metadata.until as string;
    const maxIterations = (node.metadata.max_iterations as number) ?? 100;
    const body = node.children?.[0];
    if (!body) {
      throw new Error(`loop node ${node.id} missing body pipeline`);
    }

    let lastOutput: unknown;
    for (let iter = 0; iter < maxIterations; iter++) {
      const loopCtx: ExpressionContext = {
        ...ctx,
        loop: { iter, last: lastOutput }
      };
      const loopDynamic = appendDynamicFrame(dynamic, { loopRound: iter });

      // Check until condition (skip on first iteration)
      if (untilExpr && iter > 0) {
        const done = this.evaluator.evaluateExpression(untilExpr, loopCtx);
        if (done) break;
      }

      try {
        lastOutput = primaryOutput(await this.executeNode(body, loopCtx, runId, loopDynamic, keyPrefix));
      } catch (error) {
        if (error instanceof ScopeCompleted) return { output: primaryOutput(error.output) };
        throw error;
      }
    }

    return { output: lastOutput ?? {} };
  }

  private executeGuard(node: IrNode, ctx: ExpressionContext): GuardExecutionResult {
    const when = node.metadata.when as string | undefined;
    if (!when) {
      throw new Error(`guard node ${node.id} missing 'when' expression`);
    }
    const matched = Boolean(this.evaluator.evaluateExpression(when, ctx));
    const action = (matched ? node.metadata.then : node.metadata.else) as GuardAction | undefined;
    if (action !== "continue" && action !== "fail" && action !== "complete") {
      throw new Error(`guard node ${node.id}: action must be continue, fail, or complete`);
    }

    const guardOutput: GuardOutput = { matched, action };

    if (action === "fail") {
      const messageTemplate = node.metadata.message;
      const message = typeof messageTemplate === "string" ? this.evaluator.evaluateTemplate(messageTemplate, ctx) : undefined;
      if (message !== undefined) guardOutput.message = message;
      throw new GuardFailureError(message ?? `Guard '${node.id}' failed`, { output: guardOutput });
    }

    return { output: { output: guardOutput }, completeScope: action === "complete" };
  }

  private async executeSignal(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<unknown> {
    const timeout = node.metadata.timeout as string | undefined;
    const onTimeout = node.metadata.on_timeout as string | undefined;
    const defaultPayload = node.metadata.default;
    const outputSchema = node.metadata.output as Record<string, unknown> | undefined;

    const timeoutMs = timeout ? parseDurationMs(timeout) : undefined;
    const resolverKey = `${runId}:${nodeKey}`;

    // Render the prompt the operator must act on. The Signal Node is the one
    // place a human is expected to inject data, so the rendered prompt (and the
    // expected payload schema, already on node.metadata.output) must be visible
    // in `runs show` / TUI. Persist it the same way Agent prompts are surfaced.
    const promptTemplate = node.metadata.prompt;
    if (typeof promptTemplate === "string") {
      let renderedPrompt: string;
      try {
        renderedPrompt = this.evaluator.evaluateTemplate(promptTemplate, ctx);
      } catch (error) {
        throw new LeafExecutionError(
          `Signal step '${node.id}' failed (config): Failed to evaluate signal prompt template: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.publishRenderedPrompt(runId, nodeKey, renderedPrompt);
    }

    // Enter the `awaiting` state: the node is now blocked on an external
    // decision. This is deliberately distinct from operator `paused` (see state
    // machine); a signal payload resolves it, a cancel aborts it.
    const enterState = this.store.readNodeState(runId, nodeKey);
    if (enterState && canTransition(enterState.state, "awaiting")) {
      const from = enterState.state;
      enterState.state = transition(enterState.state, "awaiting") as NodeState;
      this.store.writeNodeState(runId, enterState);
      // Surface the running → awaiting transition to onStateChange observers.
      await this.emitNodeLifecycle(runId, "onStateChange", node, nodeKey, enterState, this.dynamicFromCtx(ctx), ctx, from);
    }

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        // Honor the operator intent recorded by Run-level pause/cancel. An
        // awaiting signal node is normally cancelled (awaiting → cancelled).
        reject(new NodeAbortedError(nodeKey, this.runControl.abortIntent(runId, nodeKey)));
      };

      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup();
            // The compiler guarantees on_timeout is "fail" or "default" whenever
            // timeout is set. "default" resolves with the literal default payload
            // (already schema-checked at compile time); "fail" rejects.
            if (onTimeout === "default") {
              resolve({ output: defaultPayload ?? {} });
            } else {
              reject(new Error(`Signal timed out after ${timeout} (on_timeout: fail)`));
            }
          }, timeoutMs)
        : undefined;

      signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.signalResolvers.delete(resolverKey);
      };

      // External decision channel: an operator/system `signal` resolves the
      // node with a structured payload. With no `timeout` configured, the node
      // waits indefinitely for this (or a cancel). The resolver validates the
      // payload against the declared output schema; an invalid payload throws
      // back to the caller (the HTTP endpoint maps it to 422) and the node
      // stays `awaiting` because cleanup() has not run.
      this.signalResolvers.set(resolverKey, (payload: unknown) => {
        validateSignalPayload(outputSchema, payload);
        cleanup();
        resolve({ output: payload });
      });
    });
  }

  /**
   * Submit an external decision payload to a Signal Node that is currently
   * `awaiting`. Validates the payload against the node's output schema (when
   * declared) and resolves the in-memory promise registered by executeSignal,
   * which lets executeNode transition the node `awaiting → completed` with the
   * payload as output. Throws if the node is not awaiting (no live resolver) or
   * if the payload fails schema validation (the node stays `awaiting`).
   */
  submitSignal(runId: string, nodeKey: string, payload: unknown): void {
    const resolver = this.signalResolvers.get(`${runId}:${nodeKey}`);
    if (!resolver) {
      throw new Error(`Node ${nodeKey} is not awaiting a signal`);
    }
    // resolver throws SignalPayloadValidationError on a non-conforming payload
    // without consuming the awaiting state.
    resolver(payload);
  }

  private async executeSubworkflow(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic, nodeKey: string): Promise<unknown> {
    const specPath = node.metadata.subworkflow as string;
    const inputSpec = node.metadata.input as Record<string, unknown> | undefined;

    // Resolve the child spec path relative to the parent spec, falling back to cwd.
    const parentIr = this.store.readIr(runId);
    const baseDir = parentIr?.source.path ? dirname(parentIr.source.path) : process.cwd();
    const childAbs = resolve(baseDir, specPath);
    const childReal = this.resolveExistingSourcePath(childAbs, `Subworkflow path '${specPath}' does not exist or is not readable`);

    // Cycle guard across nested subworkflows (uses real path).
    if (this.subworkflowStack.has(childReal)) {
      throw new Error(`Subworkflow cycle detected for '${specPath}'`);
    }

    // Compile the child spec at runtime (file I/O lives in the runtime layer).
    const source = readFileSync(childReal, "utf8");
    const compiled = compileWorkflow(source, {
      sourcePath: childReal,
      includeResolver: (includePath, fromPath) => {
        const dir = fromPath ? dirname(resolve(fromPath)) : process.cwd();
        const includeAbs = resolve(dir, includePath);
        const includeReal = this.resolveExistingSourcePath(includeAbs, `Include path '${includePath}' does not exist or is not readable`);
        return readFileSync(includeReal, "utf8");
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
      childInput[key] = evaluateTemplatedValue(value, ctx, this.evaluator);
    }

    // Validate subworkflow input against the child IR's compiled input schema.
    const validatedChildInput = validateInput(compiled.ir.input, childInput);

    // Execute the child root as a nested pipeline. Child node keys are nested
    // under this subworkflow's node key to stay unique within the run.
    this.subworkflowStack.add(childReal);
    try {
      const childCtx = this.buildContext(compiled.ir, validatedChildInput, runId);
      await this.executeNode(compiled.ir.root, childCtx, runId, dynamic, nodeKey);
      return { output: evaluateWorkflowOutputs(compiled.ir, childCtx, this.evaluator) };
    } finally {
      this.subworkflowStack.delete(childReal);
    }
  }

  private resolveExistingSourcePath(path: string, message: string): string {
    const realPath = realPathOrUndefined(path);
    if (realPath === undefined) {
      throw new Error(message);
    }
    return realPath;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private buildContext(ir: AcpusIr, input: Record<string, unknown>, runId: string): ExpressionContext {
    return { input, steps: {}, workflow: buildWorkflowExpressionContext(ir), run_id: runId };
  }


  private hydrateContextForNodeRetry(
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    targetNodeKey: string,
    dynamic: NodeKeyDynamic,
    keyPrefix?: string
  ): { ctx: ExpressionContext; dynamic: NodeKeyDynamic } | undefined {
    const nodeKey = withNodeKeyPrefix(keyPrefix, resolveNodeKey(node.keyTemplate, dynamic));
    if (nodeKey === targetNodeKey) return { ctx, dynamic };

    const state = this.store.readNodeState(runId, nodeKey);
    if (state?.state === "completed" && state.output !== undefined && node.metadata.implicit !== true) {
      ctx.steps[node.id] = expressionOutputForNode(node, state.output);
      return undefined;
    }

    if (node.kind === "pipeline") {
      const frame = node.metadata.implicit === true ? ctx : { ...ctx, steps: { ...ctx.steps } };
      for (const child of node.children ?? []) {
        const found = this.hydrateContextForNodeRetry(child, frame, runId, targetNodeKey, dynamic, keyPrefix);
        if (found) return found;
      }
      return undefined;
    }

    if (node.kind === "parallel") {
      for (const branch of node.branches ?? []) {
        const branchCtx: ExpressionContext = { ...ctx, steps: { ...ctx.steps } };
        const branchDynamic = nestedParallelBranchDynamic(dynamic, branch.id);
        const found = this.hydrateContextForNodeRetry(branch.child, branchCtx, runId, targetNodeKey, branchDynamic, keyPrefix);
        if (found) return found;
      }
      return undefined;
    }

    for (const child of node.children ?? []) {
      const found = this.hydrateContextForNodeRetry(child, ctx, runId, targetNodeKey, dynamic, keyPrefix);
      if (found) return found;
    }
    for (const branch of node.branches ?? []) {
      const found = this.hydrateContextForNodeRetry(branch.child, ctx, runId, targetNodeKey, dynamic, keyPrefix);
      if (found) return found;
    }
    return undefined;
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

  /** Merge a persisted dynamic value-context back into a rebuilt context (retry/continuation). */
  private restoreDynamicContext(ctx: ExpressionContext, snapshot: import("./types.js").NodeDynamicContext | undefined): void {
    if (!snapshot) return;
    if (snapshot.item !== undefined) ctx.item = snapshot.item;
    if (snapshot.item_id !== undefined) ctx.item_id = snapshot.item_id;
    if (snapshot.item_index !== undefined) ctx.item_index = snapshot.item_index;
    if (snapshot.loop !== undefined) ctx.loop = snapshot.loop;
  }

  private findNodeByKey(root: IrNode, nodeKey: string): IrNode | undefined {
    const staticPath = staticNodePathFromKey(nodeKey);
    return this.findNodeByPath(root, staticPath);
  }

  private findNodeByPath(root: IrNode, staticPath: string): IrNode | undefined {
    if (root.nodePath.join("/") === staticPath) return root;

    for (const child of root.children ?? []) {
      const found = this.findNodeByPath(child, staticPath);
      if (found) return found;
    }

    for (const branch of root.branches ?? []) {
      const found = this.findNodeByPath(branch.child, staticPath);
      if (found) return found;
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

  // ─── Hook integration ───────────────────────────────────────────

  /** Run scope for the active Run, derived from the frozen IR + metadata. */
  private resolveRunScope(runId: string): RunScope | undefined {
    if (!this.hookRunner) return undefined;
    const ir = this.store.readIr(runId);
    const meta = this.store.readRunMeta(runId);
    if (!ir || !meta) return undefined;
    return runScope(ir, meta);
  }

  /** Lazily create the per-Run injector journal. */
  private journalFor(runId: string): HookJournal {
    if (!this.hookJournal) {
      this.hookJournal = new HookJournal(join(this.store.getBaseDir(), runId));
    }
    return this.hookJournal;
  }

  /**
   * Run an injector for a node, journaling each handler invocation. Returns the
   * merged InjectorResult, or undefined when no hook runner / no handlers.
   * An injector failure under `fail` policy propagates as HookFailureError,
   * which executeNode maps to a node failure with failureKind hook_failure.
   */
  private async runInjector(
    name: InjectorName,
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    nodeKey: string,
    enrich?: (payload: HookPayload) => void
  ): Promise<InjectorResult | undefined> {
    if (!this.hookRunner || !this.hookRunner.hasInjector(name)) return undefined;
    const scope = this.resolveRunScope(runId);
    if (!scope) return undefined;

    const state = this.store.readNodeState(runId, nodeKey);
    const nodeAttempt = state?.attempt ?? 1;
    const isRetry = nodeAttempt > 1;
    const payload = withNodeFields(basePayload(scope, name), node, nodeKey, state, this.dynamicFromCtx(ctx), ctx);
    payload.is_retry = isRetry;
    // Note: `beforeAgentExec` runs before the prompt is rendered, so we do NOT
    // surface state.renderedPrompt here — it would be absent on first execution
    // and stale on retry. The rendered prompt is carried by lifecycle events.
    enrich?.(payload);

    const journal = this.journalFor(runId);
    return this.hookRunner.runInjector(name, payload, (handlerIndex, result, durationMs) => {
      journal.append({
        node_key: nodeKey,
        injector: name,
        handler_index: handlerIndex,
        node_attempt: nodeAttempt,
        is_retry: isRetry,
        prepend_prompt: name === "beforeAgentExec" ? ((result as AgentInjectorResult).prependPrompt ?? null) : null,
        env: (result as ProgramInjectorResult).env ?? null,
        timestamp: new Date().toISOString(),
        duration_ms: durationMs
      });
    });
  }

  /** Fire a node lifecycle event plus onStateChange for an actual transition. */
  private async emitNodeLifecycle(
    runId: string,
    name: EventName,
    node: IrNode,
    nodeKey: string,
    state: NodeExecutionState,
    dynamic: NodeKeyDynamic,
    ctx: ExpressionContext,
    fromState: NodeState,
    error?: unknown
  ): Promise<void> {
    if (!this.hookRunner) return;
    const firesSpecific = this.hookRunner.hasEvent(name);
    const firesStateChange = this.hookRunner.hasEvent("onStateChange");
    if (!firesSpecific && !firesStateChange) return;
    const scope = this.resolveRunScope(runId);
    if (!scope) return;
    const hookFailure = error instanceof HookFailureError;

    const build = (eventName: string): HookPayload => {
      const p = withNodeFields(basePayload(scope, eventName), node, nodeKey, state, dynamic, ctx);
      if (state.output !== undefined) p.output = state.output;
      if (state.startedAt && state.completedAt) {
        p.duration_ms = Date.parse(state.completedAt) - Date.parse(state.startedAt);
      }
      // beforeAgentExec aside, lifecycle events carry the rendered prompt.
      if (state.renderedPrompt) p.prompt = state.renderedPrompt;
      if (state.renderedSessionKey) p.session_key = state.renderedSessionKey;
      if (node.kind === "run.agent") {
        const telemetry = hookAgentTelemetry(state);
        if (telemetry) p.agent_telemetry = telemetry;
      }
      if (error !== undefined) p.error = error instanceof Error ? error.message : String(error);
      this.fillParentFields(runId, node, nodeKey, p);
      fillCompositeFields(node, p);
      const leaf = this.leafMeta.get(nodeKey);
      if (leaf) {
        if (leaf.failureKind !== undefined) p.failure_kind = leaf.failureKind;
        // Program detail.
        if (leaf.command !== undefined) p.command = leaf.command;
        if (leaf.shell !== undefined) p.shell = leaf.shell;
        if (leaf.subprocessEnv !== undefined) p.subprocess_env = leaf.subprocessEnv;
        if (leaf.exitCode !== undefined) p.exit_code = leaf.exitCode;
        if (leaf.stdout !== undefined) p.stdout = leaf.stdout;
        if (leaf.stderr !== undefined) p.stderr = leaf.stderr;
        // Agent detail.
        if (leaf.agentModel !== undefined) p.agent_model = leaf.agentModel;
        if (leaf.agentType !== undefined) p.agent_type = leaf.agentType;
        if (leaf.agentPolicy !== undefined) p.agent_policy = leaf.agentPolicy;
        if (leaf.sessionKey !== undefined) p.session_key = leaf.sessionKey;
        if (leaf.agentExitCode !== undefined) p.agent_exit_code = leaf.agentExitCode;
        if (leaf.agentResponseText !== undefined) p.agent_response_text = leaf.agentResponseText;
      } else if (hookFailure) {
        // A node that failed because an injector failed under `fail` policy.
        p.failure_kind = "hook_failure";
      }
      return p;
    };

    // The specific lifecycle event (onNodeStart/Complete/... ); onStateChange is
    // never emitted via this branch — it always carries from/to below.
    if (firesSpecific && name !== "onStateChange") await this.hookRunner.emitEvent(name, build(name));
    // onStateChange only fires when the state field actually changed.
    if (firesStateChange && fromState !== state.state) {
      const p = build("onStateChange");
      p.from_state = fromState;
      p.to_state = state.state;
      await this.hookRunner.emitEvent("onStateChange", p);
    }
  }

  /** Fire a run-level event (beforeRun / afterRun). */
  private async emitRunEvent(name: EventName, scope: RunScope, enrich: (payload: HookPayload) => void): Promise<void> {
    if (!this.hookRunner || !this.hookRunner.hasEvent(name)) return;
    const payload = basePayload(scope, name);
    enrich(payload);
    await this.hookRunner.emitEvent(name, payload);
  }

  /** Recover the dynamic key dimensions from an expression context. */
  private dynamicFromCtx(ctx: ExpressionContext): NodeKeyDynamic {
    const dynamic: NodeKeyDynamic = {};
    if (ctx.loop?.iter !== undefined) dynamic.loopRound = ctx.loop.iter;
    if (ctx.item_id !== undefined) dynamic.fanoutItemId = ctx.item_id;
    return dynamic;
  }

  /**
   * Populate parent_node_key/parent_node_kind from the Run's frozen IR. The
   * parent's resolved key shares this node's dynamic prefix, so we map the
   * static parent path onto the dynamic portion of the child key.
   */
  private fillParentFields(runId: string, node: IrNode, nodeKey: string, payload: HookPayload): void {
    const ir = this.store.readIr(runId);
    if (!ir) return;
    const parent = findParentNode(ir.root, node.id);
    if (!parent || parent.id === ir.root.id && parent.kind === "pipeline") {
      // The workflow root is an implicit container; only surface real parents.
      if (!parent || parent.nodePath.length === 0) return;
    }
    if (!parent) return;
    payload.parent_node_kind = parent.kind;
    // The child static path is parent path + child id; the parent's resolved key
    // is the child key with the trailing static `/childId` segment removed.
    const childStatic = staticNodePathFromKey(nodeKey);
    const childIdSeg = `/${node.id}`;
    if (childStatic.endsWith(childIdSeg)) {
      const idx = nodeKey.lastIndexOf(childIdSeg);
      if (idx > 0) payload.parent_node_key = nodeKey.slice(0, idx);
    }
  }

  /** Drop per-node leaf metadata once its terminal events have fired. */
  private clearLeafMeta(nodeKey: string): void {
    this.leafMeta.delete(nodeKey);
  }
}

/** Result of a single fanout lane: success carries the output, failure the message. */
type LaneResult = { ok: true; output: unknown } | { ok: false; error: string };

type GuardAction = "continue" | "fail" | "complete";

interface GuardOutput {
  matched: boolean;
  action: GuardAction;
  message?: string;
}

interface GuardExecutionResult {
  output: { output: GuardOutput };
  completeScope: boolean;
}

/** Output + artifact references produced by a leaf (agent/program) execution. */
interface LeafResult {
  output: unknown;
  artifactRefs?: string[];
}

/** Leaf execution detail captured for hook onNodeComplete/Error payloads. */
interface LeafHookMeta {
  /** Failure classification when the leaf failed (program failureKind or hook_failure). */
  failureKind?: string;
  // Program
  command?: string;
  shell?: boolean;
  subprocessEnv?: Record<string, string>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  // Agent
  agentModel?: string;
  agentType?: string;
  agentPolicy?: string;
  sessionKey?: string;
  agentExitCode?: number;
  agentResponseText?: string;
}

function hookAgentTelemetry(state: NodeExecutionState): HookAgentTelemetry | undefined {
  const telemetry = state.agentTelemetry;
  const attempt = telemetry?.attempts.find((item) => item.attempt === telemetry.currentAttempt)
    ?? telemetry?.attempts[telemetry.attempts.length - 1];
  if (!attempt) return undefined;

  const result: HookAgentTelemetry = {
    attempt: attempt.attempt,
    state: attempt.state,
    updated_at: attempt.updatedAt
  };
  if (attempt.completedAt) result.completed_at = attempt.completedAt;
  if (attempt.context) {
    result.context = {
      used: attempt.context.used,
      size: attempt.context.size,
      updated_at: attempt.context.updatedAt
    };
  }
  if (attempt.tokenUsage) {
    result.token_usage = {
      source: attempt.tokenUsage.source
    };
    if (attempt.tokenUsage.inputTokens !== undefined) result.token_usage.input_tokens = attempt.tokenUsage.inputTokens;
    if (attempt.tokenUsage.outputTokens !== undefined) result.token_usage.output_tokens = attempt.tokenUsage.outputTokens;
    if (attempt.tokenUsage.cachedReadTokens !== undefined) result.token_usage.cached_read_tokens = attempt.tokenUsage.cachedReadTokens;
    if (attempt.tokenUsage.cachedWriteTokens !== undefined) result.token_usage.cached_write_tokens = attempt.tokenUsage.cachedWriteTokens;
    if (attempt.tokenUsage.thoughtTokens !== undefined) result.token_usage.thought_tokens = attempt.tokenUsage.thoughtTokens;
    if (attempt.tokenUsage.totalTokens !== undefined) result.token_usage.total_tokens = attempt.tokenUsage.totalTokens;
  }
  return result;
}

function primaryOutput(value: unknown): unknown {
  return isRecord(value) && "output" in value ? value.output : value;
}

function expressionOutputForNode(node: IrNode, output: unknown): unknown {
  if ((node.kind !== "run.agent" && node.kind !== "run.program") || !isRecord(output)) {
    return output;
  }
  const schema = node.metadata.output;
  if (!isRecord(schema) || !("output" in output)) {
    return output;
  }
  return {
    ...output,
    output: projectValueBySchema(output.output, schema)
  };
}

function projectValueBySchema(value: unknown, schema: Record<string, unknown>): unknown {
  if (schema.type === "array") {
    if (!Array.isArray(value) || !isRecord(schema.items)) return value;
    return value.map((item) => projectValueBySchema(item, schema.items as Record<string, unknown>));
  }

  if (schema.type !== "object" || !isRecord(value)) {
    return value;
  }

  if (!isRecord(schema.properties)) {
    return {};
  }

  const projected: Record<string, unknown> = {};
  for (const [key, childSchema] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      projected[key] = isRecord(childSchema) ? projectValueBySchema(value[key], childSchema) : value[key];
    }
  }
  return projected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Generate a locally sortable run ID: yyyyMMddHHmmss + 20 uppercase hex chars. */
export function generateRunId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
  return `${timestamp}${randomBytes(10).toString("hex").toUpperCase()}`;
}

/** Find the immediate parent IR node of `childId`, or undefined for the root. */
function findParentNode(node: IrNode, childId: string): IrNode | undefined {
  for (const child of node.children ?? []) {
    if (child.id === childId) return node;
    const found = findParentNode(child, childId);
    if (found) return found;
  }
  for (const branch of node.branches ?? []) {
    if (branch.child.id === childId) return node;
    const found = findParentNode(branch.child, childId);
    if (found) return found;
  }
  return undefined;
}

/** Populate composite-container-specific payload fields from node metadata. */
function fillCompositeFields(node: IrNode, p: HookPayload): void {
  const m = node.metadata;
  switch (node.kind) {
    case "parallel":
      if (typeof m.join === "string") p.join_strategy = m.join;
      if (typeof m.max_concurrency === "number") p.max_concurrency = m.max_concurrency;
      break;
    case "fanout":
      if (typeof m.join === "string") p.join_strategy = m.join;
      if (typeof m.max_concurrency === "number") p.max_concurrency = m.max_concurrency;
      break;
    case "loop":
      if (typeof m.max_iterations === "number") p.max_iterations = m.max_iterations;
      break;
    case "subworkflow":
      if (typeof m.subworkflow === "string") p.subworkflow_spec_path = m.subworkflow;
      break;
    case "run.signal":
      if (typeof m.timeout === "string") p.signal_timeout = m.timeout;
      if (typeof m.on_timeout === "string") p.signal_on_timeout = m.on_timeout;
      break;
    default:
      break;
  }
}

class NodeAbortedError extends Error {
  constructor(
    public readonly nodeKey: string,
    public readonly state: "paused" | "cancelled",
    /** Artifact refs (e.g. partial Agent response/telemetry) to persist on the aborted node. */
    public readonly artifactRefs?: string[],
    /** Partial output captured before the abort. */
    public readonly output?: unknown
  ) {
    super(`Node ${nodeKey} aborted: ${state}`);
    this.name = "NodeAbortedError";
  }
}

class ScopeCompleted extends Error {
  constructor(public readonly output: unknown) {
    super("Scope completed by guard");
    this.name = "ScopeCompleted";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class GuardFailureError extends Error {
  constructor(message: string, public readonly output: { output: GuardOutput }) {
    super(message);
    this.name = "GuardFailureError";
  }
}

/** A non-recoverable leaf failure that still carries artifacts written before failing. */
class LeafExecutionError extends Error {
  constructor(
    message: string,
    public readonly artifactRefs?: string[],
    /** Invalid output captured before the leaf failed validation/execution. */
    public readonly output?: unknown
  ) {
    super(message);
    this.name = "LeafExecutionError";
  }
}
