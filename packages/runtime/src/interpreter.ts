import type { AcpusIr, IrNode, NodeKeyTemplate } from "@acpus/core";
import { parseDurationMs } from "@acpus/core";
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
  private readonly agentExecutor: ExecutorAdapter;
  private readonly programExecutor: ExecutorAdapter;
  private readonly artifactStore: ArtifactStore;
  private readonly maxConcurrency: number;

  /** Active abort controllers keyed by "runId:nodeKey" for pause/cancel support */
  private readonly abortControllers: Map<string, AbortController> = new Map();

  constructor(
    store: RunStore,
    agentExecutor: ExecutorAdapter,
    programExecutor: ExecutorAdapter,
    options?: InterpreterOptions
  ) {
    this.store = store;
    this.evaluator = new ExpressionEvaluator({ nowTimestamp: options?.nowTimestamp });
    this.agentExecutor = agentExecutor;
    this.programExecutor = programExecutor;
    this.artifactStore = new ArtifactStore(store.getBaseDir());
    this.maxConcurrency = options?.maxConcurrency ?? 10;
  }

  /**
   * Start a new workflow run.
   */
  async start(ir: AcpusIr, opts: RunOptions): Promise<import("./types.js").RunState> {
    const runId = opts.runId ?? randomUUID();
    const meta = this.store.initRun(runId, ir, opts.input);

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
      await this.executeNode(node, ctx, runId, {});
    }
  }

  /**
   * Cancel a node.
   */
  cancelNode(runId: string, nodeKey: string): void {
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
      await this.executeNode(node, ctx, runId, {});
    }
  }

  // ─── Node execution dispatch ──────────────────────────────────

  private async executeNode(
    node: IrNode,
    ctx: ExpressionContext,
    runId: string,
    dynamic: NodeKeyDynamic
  ): Promise<unknown> {
    const nodeKey = resolveNodeKey(node.keyTemplate, dynamic);

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

      switch (node.kind) {
        case "pipeline":
          output = await this.executePipeline(node, ctx, runId, dynamic);
          break;
        case "run.agent":
          output = await this.executeAgent(node, ctx, runId, controller.signal, nodeKey);
          break;
        case "run.program":
          output = await this.executeProgram(node, ctx, runId, controller.signal, nodeKey);
          break;
        case "parallel":
          output = await this.executeParallel(node, ctx, runId, dynamic);
          break;
        case "fanout":
          output = await this.executeFanout(node, ctx, runId, dynamic);
          break;
        case "switch":
          output = await this.executeSwitch(node, ctx, runId, dynamic);
          break;
        case "loop":
          output = await this.executeLoop(node, ctx, runId, dynamic);
          break;
        case "approval":
          output = await this.executeApproval(node, ctx, runId, controller.signal, nodeKey);
          break;
        case "subworkflow":
          output = await this.executeSubworkflow(node, ctx, runId);
          break;
        default:
          throw new Error(`Unknown node kind: ${node.kind}`);
      }

      // Transition to completed
      state.state = "completed";
      state.output = output;
      state.completedAt = new Date().toISOString();
      this.store.writeNodeState(runId, state);

      // Add output to step context
      ctx.steps[node.id] = output;

      return output;
    } catch (error) {
      if (error instanceof NodeAbortedError) {
        // Transition this node to the same state as the child that was aborted
        state.state = error.state === "paused" ? "paused" : "cancelled";
        state.error = `Aborted: ${error.state}`;
        this.store.writeNodeState(runId, state);
        throw error;
      }

      state.state = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.completedAt = new Date().toISOString();
      this.store.writeNodeState(runId, state);
      throw error;
    } finally {
      this.abortControllers.delete(`${runId}:${nodeKey}`);
    }
  }

  // ─── Kind-specific execution ───────────────────────────────────

  private async executePipeline(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic): Promise<unknown> {
    const children = node.children ?? [];
    for (const child of children) {
      await this.executeNode(child, ctx, runId, dynamic);
    }
    // Pipeline output: map of step outputs
    return { ...ctx.steps };
  }

  private async executeAgent(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<unknown> {
    const result = await this.agentExecutor.execute(node, ctx, signal);
    if (result.error && !result.partial) {
      throw new Error(`Agent execution failed: ${result.error}`);
    }
    if (result.partial) {
      const state = this.store.readNodeState(runId, nodeKey);
      if (state) {
        state.state = "paused";
        state.output = result.output;
        state.artifactRefs = result.artifactRefs;
        this.store.writeNodeState(runId, state);
      }
      throw new NodeAbortedError(nodeKey, "paused");
    }
    return result.output;
  }

  private async executeProgram(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<unknown> {
    const result = await this.programExecutor.execute(node, ctx, signal);
    if (result.error && !result.partial) {
      throw new Error(`Program execution failed: ${result.error}`);
    }
    if (result.partial) {
      const state = this.store.readNodeState(runId, nodeKey);
      if (state) {
        state.state = "paused";
        state.output = result.output;
        this.store.writeNodeState(runId, state);
      }
      throw new NodeAbortedError(nodeKey, "paused");
    }
    return result.output;
  }

  private async executeParallel(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic): Promise<unknown> {
    const children = node.children ?? [];
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;

    // Execute children concurrently with concurrency limit
    // Each branch gets a unique parallelBranchId
    const results = await this.runWithConcurrency(
      children,
      maxConcurrency,
      async (child, index) => {
        const branchDynamic: NodeKeyDynamic = { ...dynamic, parallelBranchId: String(index) };
        return this.executeNode(child, { ...ctx, steps: { ...ctx.steps } }, runId, branchDynamic);
      }
    );

    // outputMerge: "map" — collect all outputs keyed by step id
    const mapOutput: Record<string, unknown> = {};
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      mapOutput[child.id] = results[i];
      ctx.steps[child.id] = results[i];
    }
    return mapOutput;
  }

  private async executeFanout(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic): Promise<unknown> {
    const overExpr = node.metadata.over as string;
    if (!overExpr) {
      throw new Error(`fanout node ${node.id} missing 'over' expression`);
    }

    const items = this.evaluator.evaluateOverExpression(overExpr, ctx);
    const maxConcurrency = (node.metadata.max_concurrency as number) ?? this.maxConcurrency;
    const join = (node.metadata.join as string) ?? "all";
    const children = node.children ?? [];

    // For each item, execute the lane body with item context
    const results = await this.runWithConcurrency(
      items,
      maxConcurrency,
      async (item, index) => {
        const itemId = this.extractItemId(item, node.metadata.key as string | undefined, index);
        const itemDynamic: NodeKeyDynamic = {
          ...dynamic,
          fanoutItemId: itemId,
          laneId: String(index)
        };
        const itemCtx: ExpressionContext = {
          ...ctx,
          steps: { ...ctx.steps },
          item,
          item_id: itemId,
          item_index: index
        };

        // Execute children as an implicit pipeline per lane
        let laneOutput: unknown;
        for (const child of children) {
          laneOutput = await this.executeNode(child, itemCtx, runId, itemDynamic);
        }
        return laneOutput;
      }
    );

    // Join strategy
    if (join === "race") {
      return results[0];
    }

    // outputMerge: "array"
    return results;
  }

  private async executeSwitch(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic): Promise<unknown> {
    const branches = node.branches ?? [];

    for (const branch of branches) {
      if (branch.when) {
        const matches = this.evaluator.evaluateExpression(branch.when, ctx);
        if (matches) {
          let lastOutput: unknown;
          for (const child of branch.children) {
            lastOutput = await this.executeNode(child, ctx, runId, dynamic);
          }
          return lastOutput;
        }
      } else {
        // Default branch (no when condition)
        let lastOutput: unknown;
        for (const child of branch.children) {
          lastOutput = await this.executeNode(child, ctx, runId, dynamic);
        }
        return lastOutput;
      }
    }

    throw new Error(`Switch node ${node.id}: no branch matched and no default`);
  }

  private async executeLoop(node: IrNode, ctx: ExpressionContext, runId: string, dynamic: NodeKeyDynamic): Promise<unknown> {
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
        lastOutput = await this.executeNode(child, loopCtx, runId, loopDynamic);
      }
    }

    // outputMerge: "last"
    return lastOutput;
  }

  private async executeApproval(node: IrNode, ctx: ExpressionContext, runId: string, signal: AbortSignal, nodeKey: string): Promise<unknown> {
    const timeout = node.metadata.timeout as string | undefined;
    const onTimeout = node.metadata.on_timeout as string | undefined;

    const timeoutMs = timeout ? parseDurationMs(timeout) : undefined;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(new NodeAbortedError(nodeKey, "paused"));
      };

      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup();
            if (onTimeout === "approve") {
              resolve({ approved: true, timedOut: true });
            } else if (onTimeout === "reject") {
              resolve({ approved: false, timedOut: true });
            } else {
              reject(new Error(`Approval timed out after ${timeout}`));
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
          resolve({ approved: true });
        }, 100);
      }
    });
  }

  private async executeSubworkflow(node: IrNode, ctx: ExpressionContext, runId: string): Promise<unknown> {
    void node; void ctx; void runId;
    return {};
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

  private async runWithConcurrency<T>(
    items: T[],
    maxConcurrency: number,
    fn: (item: T, index: number) => Promise<unknown>
  ): Promise<unknown[]> {
    const limit = pLimit(maxConcurrency);
    return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
  }
}

class NodeAbortedError extends Error {
  constructor(
    public readonly nodeKey: string,
    public readonly state: "paused" | "cancelled"
  ) {
    super(`Node ${nodeKey} aborted: ${state}`);
    this.name = "NodeAbortedError";
  }
}
