import { Hono } from "hono";
import type { RunStore } from "./store.js";
import type { ExecutorAdapter } from "./executors/types.js";
import type { DaemonConfig, RunSummary } from "./types.js";
import { WorkflowInterpreter } from "./interpreter.js";
import { compileWorkflow } from "@acpus/core";
import type { RunState } from "./types.js";

/**
 * Creates a Hono HTTP app for the acpus daemon.
 *
 * Note: Node keys contain "/" characters (e.g. "workflow/step-a"),
 * which are incompatible with URL path segments. All node-control
 * routes accept the nodeKey as a query parameter instead.
 */
export function createDaemonApp(
  config: DaemonConfig,
  store: RunStore,
  agentExecutor: ExecutorAdapter,
  programExecutor: ExecutorAdapter,
  acpxAgentExecutor?: ExecutorAdapter
) {
  const app = new Hono();

  // Active interpreter instances
  const interpreters = new Map<string, WorkflowInterpreter>();

  /** Create an interpreter bound to this daemon's store + executors. */
  function newInterpreter(): WorkflowInterpreter {
    return new WorkflowInterpreter(store, agentExecutor, programExecutor, { acpxAgentExecutor });
  }

  /**
   * Interpreter for a forward-progress control action (resume / retry). When the
   * daemon has restarted (in-memory map empty) but the Run persists, lazily
   * recover one and reset stale `running` nodes so the action can proceed.
   * Returns `undefined` only when the Run does not exist on disk.
   */
  function getOrRecoverInterpreter(runId: string): WorkflowInterpreter | undefined {
    const live = interpreters.get(runId);
    if (live) return live;
    if (!store.hasRun(runId)) return undefined;
    const recovered = newInterpreter();
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
    // Not cached: a read-only adopter must not become the run's owning
    // interpreter (that role belongs to execution / recovery paths).
    return newInterpreter();
  }

  // ─── Runs ────────────────────────────────────────────────────────

  app.post("/runs", async (c) => {
    const body = await c.req.json<{ spec?: string; input?: Record<string, unknown> }>();
    if (!body.spec) {
      return c.json({ error: "spec is required" }, 400);
    }

    const result = compileWorkflow(body.spec);
    if (!result.ok || !result.ir) {
      return c.json({ error: "Compilation failed", diagnostics: result.diagnostics }, 400);
    }

    const interpreter = new WorkflowInterpreter(store, agentExecutor, programExecutor, { acpxAgentExecutor });
    // Initialize and register the interpreter BEFORE execution so node-control
    // routes (pause/cancel/resume/retry) can reach a running run. Execution
    // runs in the background; POST /runs returns the initial running state.
    const runState = interpreter.initRun(result.ir, { input: body.input ?? {} });
    interpreters.set(runState.runId, interpreter);
    void interpreter.runToCompletion(result.ir, { input: body.input ?? {} }, runState.runId).catch(() => undefined);

    return c.json(runState, 201);
  });

  app.get("/runs", (c) => {
    const runIds = store.listRunIds();
    const summaries: RunSummary[] = runIds.map((id) => {
      const meta = store.readRunMeta(id);
      return meta
        ? { runId: meta.runId, workflowName: meta.workflowName, status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt }
        : { runId: id, workflowName: "unknown", status: "failed" as const, createdAt: "", updatedAt: "" };
    });
    return c.json(summaries);
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

  // ─── Nodes ───────────────────────────────────────────────────────

  app.get("/runs/:runId/nodes", (c) => {
    const runId = c.req.param("runId");
    if (!store.hasRun(runId)) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json(store.listNodeStates(runId));
  });

  // Frozen IR snapshot for a run. Read-only: lets observers (e.g. the TUI)
  // render the true workflow structure — composite shapes, branch order, and
  // nodes not yet reached — and overlay live node states onto it.
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

  // Resolve an artifact URI to its absolute filesystem path so observers (e.g.
  // the TUI) can render a clickable OSC 8 hyperlink. Read-only.
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

  // ─── Node control ────────────────────────────────────────────────
  // nodeKey is passed as ?key= query param since it contains "/"

  app.post("/runs/:runId/pause", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    // Pause aborts an in-flight turn — it only makes sense for a run with a live
    // interpreter. After a restart there is no in-flight execution to abort, so
    // we do NOT lazily recover here.
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return store.hasRun(runId)
        ? c.json({ error: "Run is not actively executing; pause requires an in-flight run" }, 409)
        : c.json({ error: "Run not found" }, 404);
    }
    interpreter.pauseNode(runId, nodeKey);
    const state = store.readNodeState(runId, nodeKey);
    return c.json(state);
  });

  app.post("/runs/:runId/resume", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    const interpreter = getOrRecoverInterpreter(runId);
    if (!interpreter) {
      return c.json({ error: "Run not found" }, 404);
    }
    await interpreter.resumeNode(runId, nodeKey);
    const state = store.readNodeState(runId, nodeKey);
    return c.json(state);
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    // Cancel aborts an in-flight turn — like pause, it requires a live
    // interpreter and is not lazily recovered after a restart.
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return store.hasRun(runId)
        ? c.json({ error: "Run is not actively executing; cancel requires an in-flight run" }, 409)
        : c.json({ error: "Run not found" }, 404);
    }
    interpreter.cancelNode(runId, nodeKey);
    const state = store.readNodeState(runId, nodeKey);
    return c.json(state);
  });

  app.post("/runs/:runId/retry", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    const interpreter = getOrRecoverInterpreter(runId);
    if (!interpreter) {
      return c.json({ error: "Run not found" }, 404);
    }
    await interpreter.retryNode(runId, nodeKey);
    const state = store.readNodeState(runId, nodeKey);
    return c.json(state);
  });

  // ─── Replay ──────────────────────────────────────────────────────

  app.post("/runs/:runId/replay", (c) => {
    const runId = c.req.param("runId");
    // Replay is strictly read-only: use a non-recovering interpreter so it never
    // mutates persisted state. A mismatch is reported as ok:false (HTTP 200) so
    // the full structured diff stays readable; the CLI maps ok:false to its exit code.
    const interpreter = getReadOnlyInterpreter(runId);
    if (!interpreter) {
      return c.json({ error: "Run not found" }, 404);
    }
    const result = interpreter.replay(runId);
    return c.json(result);
  });

  // ─── Output & Artifacts ──────────────────────────────────────────

  app.get("/runs/:runId/output", (c) => {
    const runId = c.req.param("runId");
    const meta = store.readRunMeta(runId);
    if (!meta) {
      return c.json({ error: "Run not found" }, 404);
    }
    const nodes = store.listNodeStates(runId);
    const output: Record<string, unknown> = {};
    for (const node of nodes) {
      if (node.state === "completed" && node.output !== undefined) {
        output[node.nodeId] = node.output;
      }
    }
    return c.json({ status: meta.status, output });
  });

  return app;
}
