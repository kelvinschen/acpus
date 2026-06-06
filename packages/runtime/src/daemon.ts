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
export function createDaemonApp(config: DaemonConfig, store: RunStore, agentExecutor: ExecutorAdapter, programExecutor: ExecutorAdapter) {
  const app = new Hono();

  // Active interpreter instances
  const interpreters = new Map<string, WorkflowInterpreter>();

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

    const interpreter = new WorkflowInterpreter(store, agentExecutor, programExecutor);
    const runState = await interpreter.start(result.ir, { input: body.input ?? {} });
    interpreters.set(runState.runId, interpreter);

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

  // ─── Node control ────────────────────────────────────────────────
  // nodeKey is passed as ?key= query param since it contains "/"

  app.post("/runs/:runId/pause", async (c) => {
    const runId = c.req.param("runId");
    const nodeKey = c.req.query("key");
    if (!nodeKey) {
      return c.json({ error: "key query parameter is required" }, 400);
    }
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return c.json({ error: "No active interpreter for this run" }, 404);
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
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return c.json({ error: "No active interpreter for this run" }, 404);
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
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return c.json({ error: "No active interpreter for this run" }, 404);
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
    const interpreter = interpreters.get(runId);
    if (!interpreter) {
      return c.json({ error: "No active interpreter for this run" }, 404);
    }
    await interpreter.retryNode(runId, nodeKey);
    const state = store.readNodeState(runId, nodeKey);
    return c.json(state);
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
