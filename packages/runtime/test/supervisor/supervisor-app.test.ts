import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSupervisorApp } from "../../src/supervisor-app.js";
import { RunStore } from "../../src/store.js";
import { MockAgentExecutor } from "../../src/executors/mock-agent.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SPEC_YAML = `
version: 1
name: supervisor-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Test"
`;

describe("Supervisor HTTP API", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let store: RunStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-supervisor-"));
    store = new RunStore(join(tmpDir, "runs"));
    const agentExecutor = new MockAgentExecutor({
      "step-a": { output: { result: "done" }, delay: 10 }
    });
    const programExecutor = new MockProgramExecutor({});
    const { app } = createSupervisorApp({ stateDir: tmpDir }, store, agentExecutor, programExecutor);

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Poll a run until it reaches a terminal status (or time out). */
  async function pollRunStatus(runId: string, timeoutMs = 4000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const res = await fetch(`${baseUrl}/runs/${runId}/output`);
      const data = await res.json();
      if (["completed", "failed", "paused", "cancelled"].includes(data.status)) return data.status as string;
      if (Date.now() - start > timeoutMs) return data.status as string;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("starts a run via POST /runs", async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.runId).toBeDefined();
    expect(data.status).toBe("running");
    expect(data.workflowName).toBe("supervisor-test");
    expect(await pollRunStatus(data.runId)).toBe("completed");
  });

  it("accepts sourcePath in POST /runs", async () => {
    // sourcePath must be within the workspace (parent of stateDir)
    const workspace = join(tmpDir, "..");
    const sourcePath = join(workspace, "test.yaml");
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {}, sourcePath })
    });
    expect(res.status).toBe(201);
  });

  it("returns health via GET /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.schemaVersion).toBe(1);
    expect(data.pid).toBe(process.pid);
    expect(typeof data.runningCount).toBe("number");
    expect(typeof data.activeClients).toBe("number");
  });

  it("lists runs via GET /runs sorted by updatedAt descending", async () => {
    const res = await fetch(`${baseUrl}/runs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    // Verify sorted by updatedAt descending
    for (let i = 1; i < data.length; i++) {
      expect(data[i - 1].updatedAt >= data[i].updatedAt).toBe(true);
    }
  });

  it("inspects a run via GET /runs/:runId", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runId).toBe(runId);
    expect(data.nodes).toBeDefined();
  });

  it("returns 404 for unknown run", async () => {
    const res = await fetch(`${baseUrl}/runs/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("lists node states via GET /runs/:runId/nodes", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/nodes`);
    expect(res.status).toBe(200);
    const nodes = await res.json();
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("returns the frozen IR via GET /runs/:runId/ir", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/ir`);
    expect(res.status).toBe(200);
    const ir = await res.json();
    expect(ir.name).toBe("supervisor-test");
    expect(ir.root).toBeDefined();
    expect(ir.root.kind).toBe("pipeline");
  });

  it("returns 404 from GET /runs/:runId/ir for unknown run", async () => {
    const res = await fetch(`${baseUrl}/runs/nonexistent/ir`);
    expect(res.status).toBe(404);
  });

  it("resolves an artifact uri to an absolute path via GET /runs/:runId/artifact-path", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();
    await pollRunStatus(runId);

    const uri = `artifact://runs/${runId}/nodes/workflow:step-a/transcript.jsonl`;
    const res = await fetch(`${baseUrl}/runs/${runId}/artifact-path?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.absPath).toContain(`${runId}/artifacts/workflow:step-a/transcript.jsonl`);
    expect(body.absPath.startsWith("/")).toBe(true);
  });

  it("returns 400 for a malformed artifact uri", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/artifact-path?uri=not-an-artifact`);
    expect(res.status).toBe(400);
  });

  it("returns 404 from artifact-path for unknown run", async () => {
    const uri = "artifact://runs/nonexistent/nodes/workflow:step-a/x.txt";
    const res = await fetch(`${baseUrl}/runs/nonexistent/artifact-path?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(404);
  });

  it("gets a single node via GET /runs/:runId/node?key=...", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/node?key=${encodeURIComponent("workflow/step-a")}`);
    expect(res.status).toBe(200);
    const node = await res.json();
    expect(node.nodeId).toBe("step-a");
  });

  it("returns compilation errors for invalid spec", async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: "invalid: yaml", input: {} })
    });
    expect(res.status).toBe(400);
  });

  it("returns run output via GET /runs/:runId/output", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    expect(await pollRunStatus(runId)).toBe("completed");
    const res = await fetch(`${baseUrl}/runs/${runId}/output`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
    expect(data.output).toBeDefined();
  });

  it("registers the interpreter before execution so control routes reach a running run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    // Node-level pause
    const res = await fetch(`${baseUrl}/runs/${runId}/pause?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
    expect(res.status).not.toBe(404);

    await pollRunStatus(runId);
  });

  it("refreshes client leases on requests with x-acpus-client-id and x-acpus-client-kind", async () => {
    const clientId = "test-client-123";
    const res = await fetch(`${baseUrl}/health`, {
      headers: {
        "x-acpus-client-id": clientId,
        "x-acpus-client-kind": "watcher"
      }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeClients).toBeGreaterThanOrEqual(1);
  });
});

describe("Supervisor Run-level controls", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let store: RunStore;

  // A slow spec that stays running long enough to pause
  const SLOW_SPEC = `
version: 1
name: slow-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Test"
    - id: step-b
      run: agent
      use: coder
      prompt: "Test2"
`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-supervisor-ctrl-"));
    store = new RunStore(join(tmpDir, "runs"));
    const agentExecutor = new MockAgentExecutor({
      "step-a": { output: { result: "done" }, delay: 200 },
      "step-b": { output: { result: "done2" }, delay: 200 }
    });
    const programExecutor = new MockProgramExecutor({});
    const { app } = createSupervisorApp({ stateDir: tmpDir }, store, agentExecutor, programExecutor);

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Run-level pause without ?key= pauses the entire run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    // Run-level pause (no ?key=)
    const pauseRes = await fetch(`${baseUrl}/runs/${runId}/pause`, { method: "POST" });
    expect(pauseRes.status).toBe(200);
    const data = await pauseRes.json();
    expect(data.status).toBe("paused");
  });

  it("Run-level pause returns 409 for non-running run", async () => {
    // First create and pause a run
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    // Pause it
    await fetch(`${baseUrl}/runs/${runId}/pause`, { method: "POST" });

    // Try to pause again → 409
    const res = await fetch(`${baseUrl}/runs/${runId}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("Run-level cancel without ?key= cancels the entire run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    const cancelRes = await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    const data = await cancelRes.json();
    expect(data.status).toBe("cancelled");
  });

  it("Node-level control with ?key= still works", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    // Node-level pause
    const res = await fetch(`${baseUrl}/runs/${runId}/pause?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
    // May succeed or 409 depending on timing; the key is it's Node-level, not Run-level
    expect([200, 409]).toContain(res.status);
  });
});

describe("Supervisor cross-process recovery + replay", () => {
  let tmpDir: string;
  let runsDir: string;

  const FAILING_SPEC = `
version: 1
name: supervisor-restart-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Test"
    - id: step-p
      run: program
      cmd: ["false"]
`;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-supervisor-restart-"));
    runsDir = join(tmpDir, "runs");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function bootSupervisor(): Promise<{ baseUrl: string; server: Server; store: RunStore }> {
    const store = new RunStore(runsDir);
    const agentExecutor = new MockAgentExecutor({ "step-a": { output: { result: "done" }, delay: 10 } });
    const programExecutor = new MockProgramExecutor({ "step-p": { failureKind: "exit", delay: 5 } });
    const { app } = createSupervisorApp({ stateDir: tmpDir }, store, agentExecutor, programExecutor);
    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as unknown as Server));
    });
    const port = (server.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port}`, server, store };
  }

  async function pollStatus(baseUrl: string, runId: string, timeoutMs = 4000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const res = await fetch(`${baseUrl}/runs/${runId}/output`);
      const data = await res.json();
      if (["completed", "failed", "paused", "cancelled"].includes(data.status)) return data.status as string;
      if (Date.now() - start > timeoutMs) return data.status as string;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("recovers an interpreter from disk after a restart so control routes do not 404", async () => {
    const d1 = await bootSupervisor();
    const createRes = await fetch(`${d1.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: FAILING_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    expect(await pollStatus(d1.baseUrl, runId)).toBe("failed");
    await new Promise<void>((r) => d1.server.close(() => r()));

    const d2 = await bootSupervisor();
    try {
      const res = await fetch(`${d2.baseUrl}/runs/${runId}/retry?key=${encodeURIComponent("workflow/step-p")}`, { method: "POST" });
      expect(res.status).not.toBe(404);
      const missing = await fetch(`${d2.baseUrl}/runs/does-not-exist/retry?key=${encodeURIComponent("x")}`, { method: "POST" });
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((r) => d2.server.close(() => r()));
    }
  });

  it("does not lazily recover for pause/cancel after a restart (no in-flight turn)", async () => {
    const d1 = await bootSupervisor();
    const createRes = await fetch(`${d1.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: FAILING_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await pollStatus(d1.baseUrl, runId);
    await new Promise<void>((r) => d1.server.close(() => r()));

    const d2 = await bootSupervisor();
    try {
      const pauseRes = await fetch(`${d2.baseUrl}/runs/${runId}/pause?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
      expect(pauseRes.status).toBe(409);
      const cancelRes = await fetch(`${d2.baseUrl}/runs/${runId}/cancel?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
      expect(cancelRes.status).toBe(409);
      const pauseMissing = await fetch(`${d2.baseUrl}/runs/does-not-exist/pause?key=${encodeURIComponent("x")}`, { method: "POST" });
      expect(pauseMissing.status).toBe(404);
    } finally {
      await new Promise<void>((r) => d2.server.close(() => r()));
    }
  });

  it("replay does not mutate persisted state after a restart (read-only)", async () => {
    const d1 = await bootSupervisor();
    const createRes = await fetch(`${d1.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: FAILING_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await pollStatus(d1.baseUrl, runId);
    const before = d1.store.listNodeStates(runId).map((n) => ({ k: n.nodeKey, s: n.state, a: n.attempt }));
    await new Promise<void>((r) => d1.server.close(() => r()));

    const d2 = await bootSupervisor();
    try {
      const replayRes = await fetch(`${d2.baseUrl}/runs/${runId}/replay`, { method: "POST" });
      expect(replayRes.status).toBe(200);
      const after = d2.store.listNodeStates(runId).map((n) => ({ k: n.nodeKey, s: n.state, a: n.attempt }));
      expect(after).toEqual(before);
    } finally {
      await new Promise<void>((r) => d2.server.close(() => r()));
    }
  });

  it("replays a completed run deterministically (ok:true) and detects tampering (ok:false)", async () => {
    const d = await bootSupervisor();
    try {
      const createRes = await fetch(`${d.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: FAILING_SPEC, input: {} })
      });
      const { runId } = await createRes.json();
      await pollStatus(d.baseUrl, runId);

      const okRes = await fetch(`${d.baseUrl}/runs/${runId}/replay`, { method: "POST" });
      expect(okRes.status).toBe(200);
      const ok = await okRes.json();
      expect(ok.ok).toBe(true);
      expect(ok.mismatches).toEqual([]);

      const ghost = d.store.readNodeState(runId, "workflow/step-a")!;
      d.store.writeNodeState(runId, { ...ghost, nodeKey: "workflow/ghost-node", nodeId: "ghost-node" });

      const badRes = await fetch(`${d.baseUrl}/runs/${runId}/replay`, { method: "POST" });
      const bad = await badRes.json();
      expect(bad.ok).toBe(false);
      expect(bad.mismatches.some((m: { nodeKey: string; kind: string }) => m.nodeKey === "workflow/ghost-node" && m.kind === "missing-in-replay")).toBe(true);
    } finally {
      await new Promise<void>((r) => d.server.close(() => r()));
    }
  });
});
