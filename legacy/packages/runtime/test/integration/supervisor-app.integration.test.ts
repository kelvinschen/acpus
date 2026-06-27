import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSupervisorApp } from "../../src/supervisor-app.js";
import { RunStore } from "../../src/store.js";
import { StubAgentExecutor } from "../support/stub-agent.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { AgentExecutionRequest, ExecutorAdapter } from "../../src/executors/types.js";
import type { ExecutorResult } from "../../src/types.js";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeKeyToStorageKey } from "../../src/keys.js";

const SPEC_YAML = `
version: 1
name: supervisor-test
agents:
  coder:
    type: command
    use: "echo stub"
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
    const agentExecutor = new StubAgentExecutor({
      "step-a": { output: { result: "done" }, delay: 10 },
      internal: { output: { result: "done" }, delay: 10 },
      repeated: { output: { result: "lane" }, delay: 10 }
    });
    const programExecutor = new MockProgramExecutor({
      included: { stdout: "included" }
    });
    const { app } = createSupervisorApp({ stateDir: tmpDir, workspace: tmpDir }, store, agentExecutor, programExecutor);

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

  it("records skipHooks and does not freeze hook config for skipped runs", async () => {
    mkdirSync(join(tmpDir, ".acpus"), { recursive: true });
    const hookPath = join(tmpDir, ".acpus", "hooks.yaml");
    writeFileSync(hookPath, "events:\n  beforeRun:\n    - command: echo hook\n", "utf8");
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {}, skipHooks: true })
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.skipHooks).toBe(true);
    expect(data.hookConfigHash).toBeUndefined();
    expect(store.hasHookConfig(data.runId)).toBe(false);
    expect(store.readRunMeta(data.runId)?.skipHooks).toBe(true);
    expect(await pollRunStatus(data.runId)).toBe("completed");
    unlinkSync(hookPath);
  });

  it("returns hookConfigHash in the initial response when hooks are frozen", async () => {
    mkdirSync(join(tmpDir, ".acpus"), { recursive: true });
    const hookPath = join(tmpDir, ".acpus", "hooks.yaml");
    writeFileSync(hookPath, "events:\n  afterRun:\n    - command: echo hook\n", "utf8");
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.hookConfigHash).toMatch(/^sha256:/);
    expect(store.readRunMeta(data.runId)?.hookConfigHash).toBe(data.hookConfigHash);
    expect(store.hasHookConfig(data.runId)).toBe(true);
    expect(await pollRunStatus(data.runId)).toBe("completed");
    unlinkSync(hookPath);
  });

  it("applies Agent Overrides through POST /runs and exposes persisted metadata", async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: SPEC_YAML,
        input: {},
        agentOverrides: {
          coder: { type: "builtin", use: "pi", model: "test-model" }
        }
      })
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.agentOverrides).toEqual({
      coder: { type: "builtin", use: "pi", model: "test-model" }
    });
    expect(data.submissionWarnings).toBeUndefined();

    const ir = store.readIr(data.runId);
    expect(ir?.root.children?.[0]?.metadata.agent).toEqual({
      type: "builtin",
      use: "pi",
      model: "test-model"
    });
    expect(store.readRunMeta(data.runId)?.agentOverrides).toEqual(data.agentOverrides);

    const showRes = await fetch(`${baseUrl}/runs/${data.runId}`);
    expect(showRes.status).toBe(200);
    const show = await showRes.json();
    expect(show.agentOverrides).toEqual(data.agentOverrides);
    expect(await pollRunStatus(data.runId)).toBe("completed");
  });

  it("accepts sourcePath in POST /runs", async () => {
    // sourcePath must be within the workspace.
    const workspace = tmpDir;
    const sourcePath = join(workspace, "test.yaml");
    writeFileSync(sourcePath, SPEC_YAML, "utf8");
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {}, sourcePath })
    });
    expect(res.status).toBe(201);
  });

  it("returns resolved run input via GET /runs/:runId/input", async () => {
    const input = { feature_goal: "review", files: ["a.ts", "b.ts"] };
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/input`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ input });
  });

  it("returns 404 for unknown run input", async () => {
    const res = await fetch(`${baseUrl}/runs/missing-run/input`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Run not found" });
  });

  it("returns 404 when persisted input is missing for an existing run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: { feature_goal: "review" } })
    });
    const { runId } = await createRes.json();
    unlinkSync(join(store.getBaseDir(), runId, "input.json"));

    const res = await fetch(`${baseUrl}/runs/${runId}/input`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Input not found" });
  });

  it("accepts sourcePath outside workspace and global Workflow Catalog roots", async () => {
    const sourcePath = join(tmpdir(), "acpus-outside-workspace.yaml");
    writeFileSync(sourcePath, SPEC_YAML, "utf8");
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {}, sourcePath })
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(await pollRunStatus(data.runId)).toBe("completed");
    rmSync(sourcePath, { force: true });
  });

  it("resolves relative includes for submitted Workflow Specs", async () => {
    const workflowDir = join(tmpDir, ".acpus", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const sourcePath = join(workflowDir, "parent.workflow.yaml");
    writeFileSync(join(workflowDir, "child.yaml"), `
version: 1
name: included-child
workflow:
  steps:
    - id: included
      run: program
      cmd: "echo included"
`, "utf8");
    const spec = `
version: 1
name: include-parent
workflow:
  steps:
    - include: child.yaml
`;
    writeFileSync(sourcePath, spec, "utf8");

    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {}, sourcePath })
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(await pollRunStatus(data.runId)).toBe("completed");
  });

  it("accepts submitted Workflow Specs with includes outside workspace roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "acpus-supervisor-outside-"));
    try {
      const workflowDir = join(tmpDir, ".acpus", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      const sourcePath = join(workflowDir, "outside-include.workflow.yaml");
      writeFileSync(join(outside, "child.yaml"), `
version: 1
name: outside-child
workflow:
  steps:
    - id: outside
      run: program
      cmd: "echo outside"
`, "utf8");
      const spec = `
version: 1
name: outside-include-parent
workflow:
  steps:
    - include: ${join(outside, "child.yaml")}
`;
      writeFileSync(sourcePath, spec, "utf8");

      const res = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, input: {}, sourcePath })
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(await pollRunStatus(data.runId)).toBe("completed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not report non-include compile diagnostics as include resolution failures", async () => {
    const sourcePath = join(tmpDir, "invalid-shape.workflow.yaml");
    const spec = `
version: 1
name: invalid-shape
workflow:
  steps:
    - run: program
      cmd: "echo missing id"
`;
    writeFileSync(sourcePath, spec, "utf8");

    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {}, sourcePath })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Compilation failed");
    const codes = data.diagnostics.map((diagnostic: { code: string }) => diagnostic.code);
    expect(codes).toContain("STEP_ID");
    expect(codes).not.toContain("INCLUDE_RESOLUTION");
  });

  it("returns 400 for non-existent sourcePath", async () => {
    const sourcePath = "/nonexistent/path/workflow.yaml";
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {}, sourcePath })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not exist or is not readable/);
  });

  it("reports INCLUDE_RESOLUTION diagnostics for non-existent includes", async () => {
    const workflowDir = join(tmpDir, ".acpus", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const sourcePath = join(workflowDir, "missing-include.workflow.yaml");
    const spec = `
version: 1
name: missing-include-parent
workflow:
  steps:
    - include: /nonexistent/child.yaml
`;
    writeFileSync(sourcePath, spec, "utf8");

    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {}, sourcePath })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Compilation failed");
    expect(data.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)).toContain("INCLUDE_RESOLUTION");
    expect(data.diagnostics.map((diagnostic: { message: string }) => diagnostic.message).join("\n")).toMatch(/does not exist or is not readable/);
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

  it("cleans terminal runs via POST /runs/clean", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();
    expect(await pollRunStatus(runId)).toBe("completed");

    const cleanRes = await fetch(`${baseUrl}/runs/clean`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    expect(cleanRes.status).toBe(200);
    const dryRun = await cleanRes.json();
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.deleted.some((item: { runId: string }) => item.runId === runId)).toBe(true);
    expect(store.hasRun(runId)).toBe(true);

    const deleteRes = await fetch(`${baseUrl}/runs/clean`, { method: "POST" });
    expect(deleteRes.status).toBe(200);
    const deleted = await deleteRes.json();
    expect(deleted.deleted.some((item: { runId: string }) => item.runId === runId)).toBe(true);
    expect(store.hasRun(runId)).toBe(false);
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

    const uri = `artifact://runs/${runId}/nodes/workflow%2Fstep-a/attempt-001.telemetry.json`;
    const res = await fetch(`${baseUrl}/runs/${runId}/artifact-path?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.absPath.startsWith("/")).toBe(true);
    expect(body.absPath).toContain(join("artifacts", nodeKeyToStorageKey("workflow/step-a"), "attempt-001.telemetry.json"));
    expect(body.absPath).not.toContain("workflow:step-a");
    expect(existsSync(body.absPath)).toBe(true);
    expect(readFileSync(body.absPath, "utf8").length).toBeGreaterThan(0);
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
    const uri = "artifact://runs/nonexistent/nodes/workflow%2Fstep-a/x.txt";
    const res = await fetch(`${baseUrl}/runs/nonexistent/artifact-path?uri=${encodeURIComponent(uri)}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when artifact URI runId does not match route runId (H2 cross-run guard)", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();
    await pollRunStatus(runId);

    // Create a second run to have a valid target runId
    const createRes2 = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const run2 = await createRes2.json();
    await pollRunStatus(run2.runId);

    // Request artifact-path under run-a but with a URI pointing to run-b
    const crossUri = `artifact://runs/${run2.runId}/nodes/workflow%2Fstep-a/attempt-001.telemetry.json`;
    const res = await fetch(`${baseUrl}/runs/${runId}/artifact-path?uri=${encodeURIComponent(crossUri)}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("runId");
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

  it("returns only declared workflow outputs via GET /runs/:runId/output", async () => {
    const spec = `
version: 1
name: projected-output-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: internal
      run: agent
      use: coder
      prompt: "Internal"
    - id: mapped
      fanout:
        over: ["a", "b"]
        do:
          - id: repeated
            run: agent
            use: coder
            prompt: "Repeated \${{ item }}"
outputs:
  result: \${{ steps.internal.output.result }}
  lane_count: \${{ len(steps.mapped.output) }}
`;
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {} })
    });
    const { runId } = await createRes.json();

    expect(await pollRunStatus(runId)).toBe("completed");
    const res = await fetch(`${baseUrl}/runs/${runId}/output`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.output).toEqual({ result: "done", lane_count: 2 });
    expect(store.readRunMeta(runId)?.output).toEqual({ result: "done", lane_count: 2 });
    expect(data.output.internal).toBeUndefined();
    expect(data.output.repeated).toBeUndefined();

    const showRes = await fetch(`${baseUrl}/runs/${runId}`);
    expect(showRes.status).toBe(200);
    const show = await showRes.json();
    expect(show.status).toBe("completed");
    expect(show.output).toEqual({ result: "done", lane_count: 2 });
    expect(show.output.internal).toBeUndefined();
    expect(show.output.repeated).toBeUndefined();
    const root = show.nodes.find((node: { nodeKey?: string }) => node.nodeKey === "workflow");
    expect(root?.output?.output?.internal).toBeDefined();
    expect(root?.output?.output?.mapped).toBeDefined();
  });

  it("fails the run when declared workflow outputs cannot be evaluated", async () => {
    const spec = `
version: 1
name: invalid-output-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: internal
      run: agent
      use: coder
      prompt: "Internal"
outputs:
  missing: \${{ steps.internal.output.result.missing }}
`;
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {} })
    });
    const { runId } = await createRes.json();

    expect(await pollRunStatus(runId)).toBe("failed");
    const res = await fetch(`${baseUrl}/runs/${runId}/output`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("failed");
    expect(data.output).toEqual({});
    expect(data.error).toEqual(expect.any(String));
    expect(data.error).toContain("Workflow output 'missing' failed to evaluate:");
    const meta = store.readRunMeta(runId);
    expect(meta?.error).toEqual(data.error);
    expect(meta?.output).toBeUndefined();
    const root = store.readNodeState(runId, "workflow");
    expect(root?.state).toBe("failed");
    expect(root?.error).toEqual(data.error);

    const retryRes = await fetch(`${baseUrl}/runs/${runId}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(200);
    expect(await pollRunStatus(runId)).toBe("failed");
    expect(store.readNodeState(runId, "workflow")?.attempt).toBe(2);
    expect(store.readNodeState(runId, "workflow/internal")?.attempt).toBe(1);
  });

  it("registers the interpreter before execution so control routes reach a running run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();

    const res = await fetch(`${baseUrl}/runs/${runId}/pause`, { method: "POST" });
    expect(res.status).not.toBe(404);

    await pollRunStatus(runId);
  });

  it("refreshes client leases on requests with x-acpus-client-id and x-acpus-client-kind", async () => {
    const clientId = "test-client-123";
    const res = await fetch(`${baseUrl}/health`, {
      headers: {
        "x-acpus-client-id": clientId,
        "x-acpus-client-kind": "visualize"
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
    type: command
    use: "echo stub"
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
    const agentExecutor = new StubAgentExecutor({
      "step-a": { output: { result: "done" }, delay: 200 },
      "step-b": { output: { result: "done2" }, delay: 200 }
    });
    const programExecutor = new MockProgramExecutor({});
    const { app } = createSupervisorApp({ stateDir: tmpDir, workspace: tmpDir }, store, agentExecutor, programExecutor);

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

  it("Run-level pause pauses the entire run", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    const pauseRes = await fetch(`${baseUrl}/runs/${runId}/pause`, { method: "POST" });
    expect(pauseRes.status).toBe(200);
    const data = await pauseRes.json();
    expect(data.status).toBe("paused");
  });

  it("returns empty output for running, paused, and cancelled runs", async () => {
    const runningRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId: runningRunId } = await runningRes.json();
    const runningOutput = await (await fetch(`${baseUrl}/runs/${runningRunId}/output`)).json();
    expect(runningOutput).toEqual({ status: "running", output: {} });

    const pausedRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId: pausedRunId } = await pausedRes.json();
    await fetch(`${baseUrl}/runs/${pausedRunId}/pause`, { method: "POST" });
    const pausedOutput = await (await fetch(`${baseUrl}/runs/${pausedRunId}/output`)).json();
    expect(pausedOutput).toEqual({ status: "paused", output: {} });

    const cancelledRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SLOW_SPEC, input: {} })
    });
    const { runId: cancelledRunId } = await cancelledRes.json();
    await fetch(`${baseUrl}/runs/${cancelledRunId}/cancel`, { method: "POST" });
    const cancelledOutput = await (await fetch(`${baseUrl}/runs/${cancelledRunId}/output`)).json();
    expect(cancelledOutput).toEqual({ status: "cancelled", output: {} });
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

  it("Run-level cancel cancels the entire run", async () => {
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

  it("Node-level retry returns 409 (not 500) when node is not failed", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: SPEC_YAML, input: {} })
    });
    const { runId } = await createRes.json();
    // Wait for completion
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${baseUrl}/runs/${runId}/output`);
      const d = await r.json();
      if (d.status === "completed" || d.status === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Trying to retry a completed node should return 409 with a clear message, not 500
    const res = await fetch(`${baseUrl}/runs/${runId}/retry?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("only failed executable nodes are retryable");
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
    type: command
    use: "echo stub"
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
    const agentExecutor = new StubAgentExecutor({ "step-a": { output: { result: "done" }, delay: 10 } });
    const programExecutor = new MockProgramExecutor({ "step-p": { failureKind: "exit", delay: 5 } });
    const { app } = createSupervisorApp({ stateDir: tmpDir, workspace: tmpDir }, store, agentExecutor, programExecutor);
    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as unknown as Server));
    });
    const port = (server.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port}`, server, store };
  }

  async function bootSupervisorWithAgent(agentExecutor: ExecutorAdapter<AgentExecutionRequest>): Promise<{ baseUrl: string; server: Server; store: RunStore }> {
    const store = new RunStore(runsDir);
    const programExecutor = new MockProgramExecutor({});
    const { app } = createSupervisorApp({ stateDir: tmpDir, workspace: tmpDir }, store, agentExecutor, programExecutor);
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

  it("recovers interpreter now() from persisted run creation time for session_key retry", async () => {
    const spec = `
version: 1
name: supervisor-session-key-now
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      session_key: "clock-\${{ now() }}"
      prompt: "Test"
`;
    class RecordingAgentExecutor implements ExecutorAdapter<AgentExecutionRequest> {
      constructor(
        private readonly results: ExecutorResult[],
        readonly seen: string[]
      ) {}

      async execute(request: AgentExecutionRequest): Promise<ExecutorResult> {
        this.seen.push(request.sessionKey ?? "");
        return this.results.shift() ?? { output: { result: "done" } };
      }
    }

    const firstSeen: string[] = [];
    const d1 = await bootSupervisorWithAgent(new RecordingAgentExecutor([{ error: "fail" }], firstSeen));
    const createRes = await fetch(`${d1.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input: {} })
    });
    const { runId } = await createRes.json();
    expect(await pollStatus(d1.baseUrl, runId)).toBe("failed");
    const createdAt = d1.store.readRunMeta(runId)?.createdAt;
    expect(createdAt).toBeDefined();
    expect(firstSeen).toEqual([`clock-${createdAt}`]);
    await new Promise<void>((r) => d1.server.close(() => r()));

    const recoveredSeen: string[] = [];
    const d2 = await bootSupervisorWithAgent(new RecordingAgentExecutor([{ output: { result: "done" } }], recoveredSeen));
    try {
      const res = await fetch(`${d2.baseUrl}/runs/${runId}/retry?key=${encodeURIComponent("workflow/step-a")}`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(recoveredSeen).toEqual([`clock-${createdAt}`]);
    } finally {
      await new Promise<void>((r) => d2.server.close(() => r()));
    }
  });

  it("returns incremented runAttempt for Run-level retry", async () => {
    const d = await bootSupervisor();
    try {
      const createRes = await fetch(`${d.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: FAILING_SPEC, input: {} })
      });
      const { runId, runAttempt } = await createRes.json();
      expect(runAttempt).toBe(1);
      expect(await pollStatus(d.baseUrl, runId)).toBe("failed");

      const retryRes = await fetch(`${d.baseUrl}/runs/${runId}/retry`, { method: "POST" });
      expect(retryRes.status).toBe(200);
      const retry = await retryRes.json();
      expect(retry.runAttempt).toBe(2);
      expect(d.store.readRunMeta(runId)?.runAttempt).toBe(2);
      expect(await pollStatus(d.baseUrl, runId)).toBe("failed");
    } finally {
      await new Promise<void>((r) => d.server.close(() => r()));
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

describe("Supervisor signal (external decision)", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let store: RunStore;

  // A signal node with no timeout waits indefinitely for an external decision,
  // then a downstream step consumes the decision so we can prove the loop closes.
  const GATE_SPEC = `
version: 1
name: signal-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: gate
      run: signal
      prompt: "Approve?"
      output:
        approved: boolean
    - id: after
      run: agent
      use: coder
      prompt: "approved=\${{ steps.gate.output.approved }}"
outputs:
  approved: \${{ steps.gate.output.approved }}
  after_ok: \${{ steps.after.output.ok }}
`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-supervisor-signal-"));
    store = new RunStore(join(tmpDir, "runs"));
    const agentExecutor = new StubAgentExecutor({ after: { output: { ok: true }, delay: 5 } });
    const programExecutor = new MockProgramExecutor({});
    const { app } = createSupervisorApp({ stateDir: tmpDir, workspace: tmpDir }, store, agentExecutor, programExecutor);
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

  async function waitForNodeState(runId: string, nodeId: string, want: string, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const res = await fetch(`${baseUrl}/runs/${runId}/nodes`);
      const nodes = (await res.json()) as Array<{ nodeId: string; state: string }>;
      if (nodes.find((n) => n.nodeId === nodeId)?.state === want) return;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${nodeId}=${want}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

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

  it("delivers a payload end-to-end and lets downstream consume it", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();

    await waitForNodeState(runId, "gate", "awaiting");

    const sigRes = await fetch(`${baseUrl}/runs/${runId}/signal?key=${encodeURIComponent("workflow/gate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true })
    });
    expect(sigRes.status).toBe(200);
    const gateState = await sigRes.json();
    expect(gateState.state).toBe("completed");
    expect(gateState.output).toEqual({ output: { approved: true } });

    expect(await pollRunStatus(runId)).toBe("completed");
    const out = await (await fetch(`${baseUrl}/runs/${runId}/output`)).json();
    expect(out.output).toEqual({ approved: true, after_ok: true });
  });

  it("delivers an approved=false payload to complete the gate", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await waitForNodeState(runId, "gate", "awaiting");

    const sigRes = await fetch(`${baseUrl}/runs/${runId}/signal?key=${encodeURIComponent("workflow/gate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false })
    });
    expect(sigRes.status).toBe(200);
    const gateState = await sigRes.json();
    expect(gateState.state).toBe("completed");
    expect(gateState.output.output.approved).toBe(false);
  });

  it("requires a node key", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    const res = await fetch(`${baseUrl}/runs/${runId}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true })
    });
    expect(res.status).toBe(400);
    // cleanup: cancel the still-awaiting run
    await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" });
  });

  it("returns 422 for a payload that fails the declared output schema", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await waitForNodeState(runId, "gate", "awaiting");
    const res = await fetch(`${baseUrl}/runs/${runId}/signal?key=${encodeURIComponent("workflow/gate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: "yes" })
    });
    expect(res.status).toBe(422);
    // The node stays awaiting after a rejected payload.
    const nodes = await (await fetch(`${baseUrl}/runs/${runId}/nodes`)).json();
    expect(nodes.find((n: { nodeId: string }) => n.nodeId === "gate")?.state).toBe("awaiting");
    await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" });
  });

  it("returns 400 for a non-object payload", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await waitForNodeState(runId, "gate", "awaiting");
    const res = await fetch(`${baseUrl}/runs/${runId}/signal?key=${encodeURIComponent("workflow/gate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not", "an", "object"])
    });
    expect(res.status).toBe(400);
    await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" });
  });

  it("returns 409 when the node is not awaiting a decision", async () => {
    const createRes = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: GATE_SPEC, input: {} })
    });
    const { runId } = await createRes.json();
    await waitForNodeState(runId, "gate", "awaiting");
    // 'after' has not started, so it is not awaiting → 409
    const res = await fetch(`${baseUrl}/runs/${runId}/signal?key=${encodeURIComponent("workflow/after")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true })
    });
    expect(res.status).toBe(409);
    await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" });
  });

  it("returns 404 for an unknown run", async () => {
    const res = await fetch(`${baseUrl}/runs/does-not-exist/signal?key=${encodeURIComponent("workflow/gate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true })
    });
    expect(res.status).toBe(404);
  });
});
