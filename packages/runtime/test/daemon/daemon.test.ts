import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDaemonApp } from "../../src/daemon.js";
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
name: daemon-test
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

describe("Daemon HTTP API", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let store: RunStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-daemon-"));
    store = new RunStore(join(tmpDir, "runs"));
    const agentExecutor = new MockAgentExecutor({
      "step-a": { output: { result: "done" }, delay: 10 }
    });
    const programExecutor = new MockProgramExecutor({});
    const app = createDaemonApp({}, store, agentExecutor, programExecutor);

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

  it("starts a run via POST /runs", async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.runId).toBeDefined();
    expect(data.status).toBe("completed");
    expect(data.workflowName).toBe("daemon-test");
  });

  it("lists runs via GET /runs", async () => {
    const res = await fetch(`${baseUrl}/runs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
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

  it("gets a single node via GET /runs/:runId/node?key=...", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    // Node keys contain "/" so must use query param
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

    const res = await fetch(`${baseUrl}/runs/${runId}/output`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
    expect(data.output).toBeDefined();
  });
});
