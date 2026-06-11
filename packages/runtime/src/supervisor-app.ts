import { Hono } from "hono";
import type { RunStore } from "./store.js";
import type { ExecutorAdapter } from "./executors/types.js";
import type { SupervisorConfig, RunSummary, SupervisorHealth } from "./types.js";
import { WorkflowInterpreter, generateRunId } from "./interpreter.js";
import { InputValidationFailure } from "./validate-input.js";
import { compileWorkflow, workflowSourcePolicy } from "@acpus/core";
import { resolve } from "node:path";
import type { RunState } from "./types.js";
import { ForkError, applyFork, planFork, type ForkPlan } from "./fork.js";

/** Pattern that matches unsafe runId characters (path traversal, separators, null). */
const UNSAFE_RUN_ID = /(^|\/)\.\.?(\/|$)|[\\:\0]/;

/**
 * Creates a Hono HTTP app for the acpus Run Supervisor.
 *
 * Note: Node keys contain "/" characters (e.g. "workflow/step-a"), which are
 * incompatible with URL path segments. Node-addressed routes accept the nodeKey
 * as a query parameter instead.
 *
 * Returns the Hono app plus control handles for the runner to query
 * idle-shutdown state and inject health-overrides after listen.
 */
export function createSupervisorApp(
  config: SupervisorConfig,
  store: RunStore,
  agentExecutor: ExecutorAdapter,
  programExecutor: ExecutorAdapter
) {
  const app = new Hono();

  // Active interpreter instances
  const interpreters = new Map<string, WorkflowInterpreter>();

  // In-flight runToCompletion promises, keyed by runId, to prevent concurrent
  // execution races during Run-level resume or retry.
  const inFlightRuns = new Map<string, Promise<import("./types.js").RunState>>();

  // Mutex guard: runIds currently being resumed or retried. Prevents concurrent
  // resume or retry requests from starting duplicate runToCompletion executions.
  const resumingRunIds = new Set<string>();

  // Lease tracking for idle shutdown
  const clientLeases = new Map<string, { kind: string; lastSeen: number }>();
  let lastActiveAt = Date.now();

  // Health overrides set by the runner after the server binds to a port
  let healthStartedAt = "";
  let healthEndpoint = "";
  const workspaceRoot = resolve(config.workspace ?? process.cwd());
  const sourcePolicy = workflowSourcePolicy(workspaceRoot);
  const allowedSourceRoots = sourcePolicy.allowedSourceRoots;

  /** Refresh lease on every request with client headers. */
  function refreshLease(clientId: string | undefined, clientKind: string | undefined): void {
    if (!clientId || !clientKind) return;
    clientLeases.set(clientId, { kind: clientKind, lastSeen: Date.now() });
    lastActiveAt = Date.now();
  }

  /** Expire stale leases (TTL 2s). */
  function expireLeases(): void {
    const now = Date.now();
    for (const [id, lease] of clientLeases) {
      if (now - lease.lastSeen > 2000) {
        clientLeases.delete(id);
      }
    }
  }

  /** Count of non-expired leases. */
  function activeClientCount(): number {
    expireLeases();
    return clientLeases.size;
  }

  /** Count of Runs with status === "running". */
  function runningCount(): number {
    let count = 0;
    for (const runId of store.listRunIds()) {
      const meta = store.readRunMeta(runId);
      if (meta?.status === "running") count++;
    }
    return count;
  }

  /** Get the most recent active timestamp (for idle shutdown). */
  function getLastActiveAt(): number {
    expireLeases();
    let maxLease = 0;
    for (const lease of clientLeases.values()) {
      if (lease.lastSeen > maxLease) maxLease = lease.lastSeen;
    }
    return Math.max(lastActiveAt, maxLease);
  }

  /** Create an interpreter bound to this supervisor's store + executors. */
  function newInterpreter(runId?: string): WorkflowInterpreter {
    const nowTimestamp = runId ? store.readRunMeta(runId)?.createdAt : undefined;
    return new WorkflowInterpreter(store, agentExecutor, programExecutor, { allowedSourceRoots, nowTimestamp });
  }

  /**
   * Interpreter for a forward-progress control action (resume or retry). When the
   * supervisor has restarted (in-memory map empty) but the Run persists, lazily
   * recover one and reset stale `running` nodes so the action can proceed.
   * Returns `undefined` only when the Run does not exist on disk.
   */
  function getOrRecoverInterpreter(runId: string): WorkflowInterpreter | undefined {
    const live = interpreters.get(runId);
    if (live) return live;
    if (!store.hasRun(runId)) return undefined;
    const recovered = newInterpreter(runId);
    recovered.recoverStaleNodes(runId);
    interpreters.set(runId, recovered);
    return recovered;
  }

  /**
   * Read-only interpreter used by replay. Lazily creates one for cross-process
   * access but NEVER mutates persisted state (no crash recovery). Returns
   * `undefined` only when the Run does not exist on disk.
   */
  function getReadOnlyInterpreter(runId: string): WorkflowInterpreter | undefined {
    const live = interpreters.get(runId);
    if (live) return live;
    if (!store.hasRun(runId)) return undefined;
    return newInterpreter(runId);
  }

  /** Prune interpreters for terminal Runs from the in-memory map. */
  function pruneTerminalInterpreters(): void {
    for (const [runId] of interpreters) {
      const meta = store.readRunMeta(runId);
      if (meta?.status === "completed" || meta?.status === "failed" || meta?.status === "cancelled") {
        interpreters.delete(runId);
      }
    }
  }

  // ─── Lease refresh middleware (runs before route handlers) ────────

  app.use("*", async (c, next) => {
    const clientId = c.req.header("x-acpus-client-id");
    const clientKind = c.req.header("x-acpus-client-kind");
    refreshLease(clientId, clientKind);
    await next();
  });

  // ─── runId path-traversal guard ──────────────────────────────────

  app.use("/runs/:runId/*", async (c, next) => {
    const runId = c.req.param("runId");
    if (!runId || UNSAFE_RUN_ID.test(runId)) {
      return c.json({ error: "Invalid runId format" }, 400);
    }
    await next();
  });

  /** Fire-and-forget runToCompletion with proper tracking and cleanup. */
  function startRunExecution(
    interpreter: WorkflowInterpreter,
    ir: import("@acpus/core").AcpusIr,
    input: Record<string, unknown>,
    runId: string
  ): void {
    const promise = interpreter.runToCompletion(ir, { input }, runId)
      .catch((): import("./types.js").RunState => {
        // runToCompletion always resolves with the RunState (never rejects
        // with undefined), but the catch silences any unexpected throw.
        const meta = store.readRunMeta(runId);
        return meta ?? {
          runId,
          workflowName: "",
          status: "failed" as const,
          irDigest: "",
          inputDigest: "",
          createdAt: "",
          updatedAt: "",
          runAttempt: 1
        };
      })
      .finally(() => {
        inFlightRuns.delete(runId);
        pruneTerminalInterpreters();
        if (runningCount() === 0) lastActiveAt = Date.now();
      });
    inFlightRuns.set(runId, promise);
  }

  function startPersistedRunExecution(interpreter: WorkflowInterpreter, runId: string): void {
    const ir = store.readIr(runId);
    const input = store.readInput(runId);
    if (ir && input) {
      startRunExecution(interpreter, ir, input, runId);
    }
  }

  type ImmediateControlResult<T> =
    | { kind: "settled"; value: T }
    | { kind: "rejected"; error: unknown }
    | { kind: "pending" };

  /**
   * Node-level retry may run for a long time. Wait one event-loop turn so
   * synchronous validation errors surface as 409s, then detach once execution
   * has started so interactive clients are not kept alive by the request.
   */
  function settleImmediate<T>(promise: Promise<T>): Promise<ImmediateControlResult<T>> {
    return Promise.race([
      promise.then((value) => ({ kind: "settled" as const, value })).catch((error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "pending" }>((resolve) => setImmediate(() => resolve({ kind: "pending" })))
    ]);
  }

  function consumeDetachedControl(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }

  // ─── Health ──────────────────────────────────────────────────────

  app.get("/health", (c) => {
    const health: SupervisorHealth = {
      ok: true,
      schemaVersion: 1,
      workspace: workspaceRoot,
      pid: process.pid,
      endpoint: healthEndpoint,
      startedAt: healthStartedAt,
      version: "0.1.0",
      runningCount: runningCount(),
      activeClients: activeClientCount()
    };
    return c.json(health);
  });

  // ─── Runs ────────────────────────────────────────────────────────

  app.post("/runs", async (c) => {
    const body = await c.req.json<{ spec?: string; input?: Record<string, unknown>; sourcePath?: string; workflowRef?: string }>();
    if (!body.spec) {
      return c.json({ error: "spec is required" }, 400);
    }

    let sourcePath: string | undefined;
    if (body.sourcePath) {
      try {
        sourcePath = sourcePolicy.validateSourcePath(body.sourcePath);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    }

    const result = compileWorkflow(body.spec, {
      sourcePath,
      includeResolver: sourcePolicy.createIncludeResolver(sourcePath)
    });
    if (!result.ok || !result.ir) {
      return c.json({ error: "Compilation failed", diagnostics: result.diagnostics }, 400);
    }

    const initInterpreter = newInterpreter();
    let runState: RunState;
    try {
      runState = initInterpreter.initRun(result.ir, {
        input: body.input ?? {},
        workflowRef: body.workflowRef,
        workflowSourcePath: sourcePath
      });
    } catch (error) {
      if (error instanceof InputValidationFailure) {
        return c.json({ error: "Input validation failed", validationErrors: error.errors }, 400);
      }
      throw error;
    }
    const interpreter = newInterpreter(runState.runId);
    interpreters.set(runState.runId, interpreter);
    lastActiveAt = Date.now();
    // initRun has already validated and filled defaults; read the validated
    // input from the store rather than re-using the raw body.input.
    const validatedInput = store.readInput(runState.runId) ?? body.input ?? {};
    startRunExecution(interpreter, result.ir, validatedInput, runState.runId);

    return c.json(runState, 201);
  });

  app.get("/runs", (c) => {
    const runIds = store.listRunIds();
    const summaries: RunSummary[] = [];
    for (const id of runIds) {
      const meta = store.readRunMeta(id);
      if (meta) {
        summaries.push({
          runId: meta.runId,
          workflowName: meta.workflowName,
          workflowRef: meta.workflowRef,
          workflowSourcePath: meta.workflowSourcePath,
          status: meta.status,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lineage: meta.lineage
        });
      }
      // Skip corrupt Run metadata deterministically (don't crash)
    }
    // Sort by updatedAt descending, limit to most recent 50
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json(summaries.slice(0, 50));
  });

  app.get("/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const meta = store.readRunMeta(runId);
    if (!meta) {
      return c.json({ error: "Run not found" }, 404);
    }
    const nodes = store.listNodeStates(runId);
    return c.json({ ...meta, nodes });
  });

  app.post("/runs/clean", async (c) => {
    pruneTerminalInterpreters();
    const body = await c.req.json<{ dryRun?: boolean }>().catch((): { dryRun?: boolean } => ({}));
    const result = store.cleanTerminalRuns({ dryRun: Boolean(body.dryRun) });
    if (!body.dryRun) {
      for (const item of result.deleted) {
        interpreters.delete(item.runId);
      }
    }
    lastActiveAt = Date.now();
    return c.json(result);
  });

  // ─── Nodes ───────────────────────────────────────────────────────

  app.get("/runs/:runId/nodes", (c) => {
    const runId = c.req.param("runId");
    if (!store.hasRun(runId)) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json(store.listNodeStates(runId));
  });

  app.get("/runs/:runId/ir", (c) => {
    const runId = c.req.param("runId");
    if (!store.hasRun(runId)) {
      return c.json({ error: "Run not found" }, 404);
    }
    const ir = store.readIr(runId);
    if (!ir) {
      return c.json({ error: "IR not found" }, 404);
    }
    return c.json(ir);
  });

  app.get("/runs/:runId/node", (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    const state = store.readNodeState(runId, nodeKey);
    if (!state) {
      return c.json({ error: "Node not found" }, 404);
    }
    return c.json(state);
  });

  app.get("/runs/:runId/artifact-path", (c) => {
    const runId = c.req.param("runId");
    const uri = c.req.query("uri");
    if (!uri) {
      return c.json({ error: "uri query parameter is required" }, 400);
    }
    if (!store.hasRun(runId)) {
      return c.json({ error: "Run not found" }, 404);
    }
    const absPath = store.resolveArtifactPath(uri);
    if (!absPath) {
      return c.json({ error: "Invalid artifact uri" }, 400);
    }
    return c.json({ absPath });
  });

  // ─── Control ────────────────────────────────────────────────────

  app.post("/runs/:runId/pause", async (c) => {
    const runId = c.req.param("runId");

    // Run-level pause
    const meta = store.readRunMeta(runId);
    if (!meta) return c.json({ error: "Run not found" }, 404);
    if (meta.status !== "running") return c.json({ error: `Cannot pause a run in state '${meta.status}'` }, 409);
    const interpreter = interpreters.get(runId);
    if (!interpreter) return c.json({ error: "Run is not actively executing; pause requires an in-flight run" }, 409);
    interpreter.pauseRun(runId);
    const updated = store.readRunMeta(runId);
    return c.json(updated);
  });

  app.post("/runs/:runId/resume", async (c) => {
    const runId = c.req.param("runId");

    // Run-level resume
    if (resumingRunIds.has(runId)) {
      return c.json({ error: "Run is already being resumed or retried" }, 409);
    }
    const meta = store.readRunMeta(runId);
    if (!meta) return c.json({ error: "Run not found" }, 404);
    if (meta.status !== "paused") return c.json({ error: `Cannot resume a run in state '${meta.status}'` }, 409);
    // Wait for any in-flight runToCompletion to settle before resuming,
    // preventing concurrent execution race on the same interpreter.
    const inFlight = inFlightRuns.get(runId);
    if (inFlight) await inFlight;
    resumingRunIds.add(runId);
    try {
      const interpreter = getOrRecoverInterpreter(runId);
      if (!interpreter) return c.json({ error: "Run not found" }, 404);
      await interpreter.resumeRun(runId);
      interpreters.set(runId, interpreter);
      lastActiveAt = Date.now();
      startPersistedRunExecution(interpreter, runId);
      const updated = store.readRunMeta(runId);
      return c.json(updated);
    } finally {
      resumingRunIds.delete(runId);
    }
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");

    // Run-level cancel
    const meta = store.readRunMeta(runId);
    if (!meta) return c.json({ error: "Run not found" }, 404);
    if (meta.status !== "running" && meta.status !== "paused") {
      return c.json({ error: `Cannot cancel a run in state '${meta.status}'` }, 409);
    }
    const interpreter = interpreters.get(runId) ?? getOrRecoverInterpreter(runId);
    if (!interpreter) return c.json({ error: "Run not found" }, 404);
    interpreter.cancelRun(runId);
    // Wait for in-flight runToCompletion to settle after cancel, so its catch
    // block sees the "cancelled" abort intent and writes "cancelled" status
    // instead of overwriting with "paused" from a prior pauseRun.
    const inFlight = inFlightRuns.get(runId);
    if (inFlight) await inFlight;
    pruneTerminalInterpreters();
    const updated = store.readRunMeta(runId);
    return c.json(updated);
  });

  app.post("/runs/:runId/retry", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");

    if (nodeKey) {
      const interpreter = getOrRecoverInterpreter(runId);
      if (!interpreter) return c.json({ error: "Run not found" }, 404);
      const retry = interpreter.retryNode(runId, nodeKey);
      const immediate = await settleImmediate(retry);
      if (immediate.kind === "rejected") {
        const err = immediate.error;
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
      }
      if (immediate.kind === "pending") consumeDetachedControl(retry);
      lastActiveAt = Date.now();
      const state = store.readNodeState(runId, nodeKey);
      return c.json(state);
    }

    // Run-level retry
    if (resumingRunIds.has(runId)) {
      return c.json({ error: "Run is already being resumed or retried" }, 409);
    }
    const meta = store.readRunMeta(runId);
    if (!meta) return c.json({ error: "Run not found" }, 404);
    if (meta.status !== "failed") {
      return c.json({ error: `Cannot retry a run in state '${meta.status}'` }, 409);
    }
    const inFlight = inFlightRuns.get(runId);
    if (inFlight) await inFlight;
    resumingRunIds.add(runId);
    try {
      const interpreter = getOrRecoverInterpreter(runId);
      if (!interpreter) return c.json({ error: "Run not found" }, 404);
      interpreter.retryRun(runId);
      interpreters.set(runId, interpreter);
      lastActiveAt = Date.now();
      startPersistedRunExecution(interpreter, runId);
      const updated = store.readRunMeta(runId);
      return c.json(updated);
    } finally {
      resumingRunIds.delete(runId);
    }
  });

  // ─── Fork ────────────────────────────────────────────────────────
  //
  // Derive a new Run from a terminal source Run by supplying a possibly-
  // modified Workflow Spec. Inheritance is keyed by Node Definition Hash; the
  // first divergence becomes the default Fork Origin. `dryRun: true` returns
  // the plan without creating a Run.

  app.post("/runs/:runId/fork", async (c) => {
    const runId = c.req.param("runId");
    type ForkRequestBody = {
      spec?: string;
      sourcePath?: string;
      workflowRef?: string;
      input?: Record<string, unknown>;
      overrideOriginNodeKey?: string;
      dryRun?: boolean;
    };
    const body = await c.req.json<ForkRequestBody>().catch((): ForkRequestBody => ({}));

    const priorMeta = store.readRunMeta(runId);
    if (!priorMeta) return c.json({ error: "Run not found" }, 404);
    if (priorMeta.status !== "completed" && priorMeta.status !== "failed" && priorMeta.status !== "cancelled") {
      return c.json({ kind: "fork-rejected", error: `Cannot fork a run in state '${priorMeta.status}'` }, 409);
    }
    if (!store.hasCheckpointIndex(runId)) {
      return c.json({ kind: "fork-rejected", error: "Run has no checkpoint index" }, 409);
    }
    if (!body.spec) {
      return c.json({ error: "spec is required" }, 400);
    }

    let sourcePath: string | undefined;
    if (body.sourcePath) {
      try {
        sourcePath = sourcePolicy.validateSourcePath(body.sourcePath);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    }

    const compileResult = compileWorkflow(body.spec, {
      sourcePath,
      includeResolver: sourcePolicy.createIncludeResolver(sourcePath)
    });
    if (!compileResult.ok || !compileResult.ir) {
      return c.json({ kind: "fork-rejected", error: "Compilation failed", diagnostics: compileResult.diagnostics }, 400);
    }

    const checkpoints = store.readCheckpoints(runId);

    let plan: ForkPlan;
    try {
      plan = planFork(priorMeta, checkpoints, compileResult.ir, body.overrideOriginNodeKey);
    } catch (error) {
      if (error instanceof ForkError) {
        return c.json({ kind: "fork-rejected", error: error.message }, 409);
      }
      throw error;
    }

    if (body.dryRun) {
      return c.json({ dryRun: true, plan });
    }

    // Inherit input from prior Run unless explicitly supplied.
    const priorInput = store.readInput(runId) ?? {};
    const initInterpreter = newInterpreter();
    let runState: RunState;
    const forkRunId = generateRunId();
    try {
      runState = initInterpreter.initRun(compileResult.ir, {
        input: body.input ?? priorInput,
        runId: forkRunId,
        workflowRef: body.workflowRef ?? priorMeta.workflowRef,
        workflowSourcePath: sourcePath ?? priorMeta.workflowSourcePath
      });
    } catch (error) {
      if (error instanceof InputValidationFailure) {
        return c.json({ error: "Input validation failed", validationErrors: error.errors }, 400);
      }
      throw error;
    }

    applyFork(store, forkRunId, plan);

    // Stamp lineage onto the new Run's metadata after applyFork so the
    // inherited count is final.
    const meta = store.readRunMeta(forkRunId);
    if (meta) {
      meta.lineage = {
        sourceRunId: plan.sourceRunId,
        forkOriginNodeKey: plan.forkOriginNodeKey,
        inheritedNodeCount: plan.inheritedNodeKeys.length
      };
      store.writeRunMeta(forkRunId, meta);
    }

    const interpreter = newInterpreter(forkRunId);
    interpreters.set(forkRunId, interpreter);
    lastActiveAt = Date.now();
    const validatedInput = store.readInput(forkRunId) ?? body.input ?? priorInput;
    startRunExecution(interpreter, compileResult.ir, validatedInput, forkRunId);

    return c.json({ run: runState, plan }, 201);
  });

  // ─── Replay ──────────────────────────────────────────────────────

  app.post("/runs/:runId/replay", (c) => {
    const runId = c.req.param("runId");
    const interpreter = getReadOnlyInterpreter(runId);
    if (!interpreter) return c.json({ error: "Run not found" }, 404);
    const result = interpreter.replay(runId);
    return c.json(result);
  });

  // ─── Approval signal ─────────────────────────────────────────────
  //
  // Deliver a human-in-the-loop decision to an Approval Gate that is currently
  // `awaiting`. Node-addressed only (`?key=` required). The resolver lives in
  // the in-memory interpreter, so a live in-flight run is required (409
  // otherwise).

  app.post("/runs/:runId/signal", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required (approval signals are node-level)" }, 400);
    }

    const body = await c.req
      .json<{ kind?: string; approved?: boolean }>()
      .catch(() => ({}) as { kind?: string; approved?: boolean });
    if (body.kind !== "approval") {
      return c.json({ error: `Unsupported signal kind '${body.kind ?? ""}'; only 'approval' is supported` }, 400);
    }
    if (typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required" }, 400);
    }

    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return store.hasRun(runId)
        ? c.json({ error: "Run is not actively executing; signal requires an in-flight run" }, 409)
        : c.json({ error: "Run not found" }, 404);
    }

    try {
      interpreter.submitApproval(runId, nodeKey, body.approved);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    // submitApproval resolves the in-memory promise; the awaiting → completed
    // write happens in the executeNode continuation on a later microtask. Wait
    // briefly for the node to leave `awaiting` so we return the settled state.
    let state = store.readNodeState(runId, nodeKey);
    for (let i = 0; i < 100 && state?.state === "awaiting"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      state = store.readNodeState(runId, nodeKey);
    }
    return c.json(state);
  });

  // ─── Output & Artifacts ──────────────────────────────────────────

  app.get("/runs/:runId/output", (c) => {
    const runId = c.req.param("runId");
    const meta = store.readRunMeta(runId);
    if (!meta) return c.json({ error: "Run not found" }, 404);
    const nodes = store.listNodeStates(runId);
    const output: Record<string, unknown> = {};
    for (const node of nodes) {
      if (node.state === "completed" && node.output !== undefined) {
        output[node.nodeId] = node.output;
      }
    }
    return c.json({ status: meta.status, output });
  });

  return {
    app,
    /** Expose for the runner to read idle-shutdown state. */
    getLastActiveAt: () => getLastActiveAt(),
    /** Expose for the runner to check how many Runs are still active. */
    runningCount: () => runningCount(),
    /** Expose for the runner to write the startedAt and endpoint after listen. */
    setHealthOverrides: (overrides: { startedAt?: string; endpoint?: string }) => {
      if (overrides.startedAt) healthStartedAt = overrides.startedAt;
      if (overrides.endpoint) healthEndpoint = overrides.endpoint;
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
