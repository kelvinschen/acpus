import type { AcpusIr, IrNode, NodeKeyTemplate } from "@acpus/core";
import { parseDurationMs, compileWorkflow } from "@acpus/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExpressionContext, InterpreterOptions, NodeKeyDynamic, RunOptions } from "./types.js";
import { RunStore } from "./store.js";
import { ExpressionEvaluator } from "./evaluator.js";
import { resolveNodeKey } from "./keys.js";
import { canTransition, transition, createInitialNodeState, isTerminal } from "./state-machine.js";
import { ArtifactStore } from "./artifacts.js";
import type { ExecutorAdapter } from "./executors/types.js";
import type { NodeExecutionState, NodeState } from "./types.js";
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
    const runId = opts.runId ?? randomUUID();
    return this.store.initRun(runId, ir, opts.input);
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
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        nodeState.state = "pending";
        this.store.writeNodeState(runId, nodeState);
      }
    }

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
   * Pause a running node.
   */
  pauseNode(runId: string, nodeKey: string): void {
    this.abortIntents.set(`${runId}:${nodeKey}`, "paused");
    const controller = this.abortControllers.get(`${runId}:${nodeKey}`);
    if (controller) {
      controller.abort();
    }

    const state = this.store.readNodeState(runId, nodeKey);
    if (state && !isTerminal(state.state)) {
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
    state.state = transition(state.state, "running") as NodeState;
    state.attempt++;
    this.store.writeNodeState(runId, state);

    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) return;

    const node = this.findNodeByKey(ir.root, nodeKey);
    if (node) {
      const ctx = this.buildContext(input, runId);
      this.populateStepOutputs(runId, ctx);
      // Resume re-enters the node as a continuation (continuation prompt for
      // agents), preserving the original full node key for stable identity.
      await this.executeNode(node, ctx, runId, {}, undefined, true, nodeKey);
    }
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
    if (state && !isTerminal(state.state)) {
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
   */
  async retryNode(runId: string, nodeKey: string): Promise<void> {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) {
      throw new Error(`Node ${nodeKey} not found in run ${runId}`);
    }
    // Reset to pending for retry (bypasses state machine intentionally —
    // retry is a control-plane operation that resets a terminal state)
    state.state = "pending";
    state.attempt++;
    state.error = undefined;
    this.store.writeNodeState(runId, state);

    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) return;

    const node = this.findNodeByKey(ir.root, nodeKey);
    if (node) {
      const ctx = this.buildContext(input, runId);
      this.populateStepOutputs(runId, ctx);
      // Retry re-runs the Activity as a continuation: for agents this resumes
      // the same acpx session (recovering a dead subprocess) via the fixed
      // continuation prompt rather than replaying the original turn. The
      // original full node key is preserved for stable identity.
      await this.executeNode(node, ctx, runId, {}, undefined, true, nodeKey);
    }
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

    // Set up abort controller
    const controller = new AbortController();
    this.abortControllers.set(`${runId}:${nodeKey}`, controller);

    // Transition to running
    if (canTransition(state.state, "running")) {
      state.state = transition(state.state, "running") as NodeState;
    }
    state.attempt++;
    state.startedAt = new Date().toISOString();
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
      const result = await executor.execute({ node, context: ctx, signal, nodeKey, resume });

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
        throw new LeafExecutionError(`Agent execution failed${result.failureKind ? ` (${result.failureKind})` : ""}: ${result.error ?? "unknown"}`, artifactRefs);
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
      throw new LeafExecutionError(`Program execution failed (${result.failureKind}): ${result.error ?? "unknown"}`, artifactRefs);
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
        const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index);
        const itemDynamic: NodeKeyDynamic = { ...dynamic, fanoutItemId: itemId, laneId: String(index) };
        const itemCtx: ExpressionContext = {
          ...ctx,
          steps: { ...ctx.steps },
          item,
          item_id: itemId,
          item_index: index
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

      // For now, auto-approve in non-daemon mode after a short delay
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

    // Execute the child root as a nested pipeline. Child node keys are nested
    // under this subworkflow's node key to stay unique within the run.
    this.subworkflowStack.add(childAbs);
    try {
      const childCtx = this.buildContext(childInput, runId);
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

  private extractItemId(item: unknown, keyExpr?: string, index?: number): string {
    if (keyExpr && typeof item === "object" && item !== null) {
      const val = (item as Record<string, unknown>)[keyExpr];
      if (typeof val === "string") return val;
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
